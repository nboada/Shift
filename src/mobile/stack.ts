// The phone's navigation stack: full-screen pages that slide in from the right, a back button named after the page
// underneath, swipe from the left edge to go back, and large titles that hand over to the bar as the page scrolls.
// Pages underneath stay in the DOM (hidden from view and from VoiceOver), so their scroll position survives.
import { iconClass } from "../icons";
import { settings } from "../settings";

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";
const DURATION = 500;
/** How far the page underneath sits to the left while covered, as a share of the width (UIKit's parallax). */
const UNDER = 0.3;

export type Page = {
  el: HTMLElement;
  /** The scrolling area, under the bar. */
  scroller: HTMLElement;
  content: HTMLElement;
  bar: HTMLElement;
  /** Buttons at the right end of the bar. */
  end: HTMLElement;
  setTitle: (title: string) => void;
  title: string;
  /** Runs once the page has been popped and removed. */
  onClose?: () => void;
};

const reduced = () => settings.accessibility.reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches;
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function createStack(root: HTMLElement) {
  const pages: Page[] = [];
  let moving = false;

  /** A page with a bar, a large title and a scrolling body; `className` styles the screen. */
  function page(title: string, className: string): Page {
    const el = document.createElement("section");
    el.className = `m-page ${className}`;
    el.innerHTML = `<header class="m-bar">
        <button type="button" class="m-back" hidden><i class="ti ti-chevron-left" aria-hidden="true"></i><span></span></button>
        <h1 class="m-bar-title" aria-hidden="true"></h1>
        <div class="m-bar-end"></div>
      </header>
      <div class="m-scroll"><h2 class="m-title"></h2><div class="m-content"></div></div>`;
    const scroller = el.querySelector<HTMLElement>(".m-scroll")!;
    const big = el.querySelector<HTMLElement>(".m-title")!;
    const p: Page = {
      el,
      scroller,
      content: el.querySelector(".m-content")!,
      bar: el.querySelector(".m-bar")!,
      end: el.querySelector(".m-bar-end")!,
      title,
      setTitle(t) {
        p.title = t;
        big.textContent = t;
        el.querySelector(".m-bar-title")!.textContent = t;
        el.setAttribute("aria-label", t);
        const above = pages[pages.indexOf(p) + 1];
        if (above) backLabel(above);
      },
    };
    p.setTitle(title);
    // The bar's own small title shows once the large one has scrolled under it.
    scroller.addEventListener(
      "scroll",
      () => el.classList.toggle("m-scrolled", scroller.scrollTop > big.offsetTop + big.offsetHeight - 8),
      { passive: true },
    );
    el.querySelector(".m-back")!.addEventListener("click", () => void pop());
    return p;
  }

  function backLabel(p: Page) {
    const under = pages[pages.indexOf(p) - 1];
    const back = p.el.querySelector<HTMLButtonElement>(".m-back")!;
    back.hidden = !under;
    if (!under) return;
    back.querySelector("span")!.textContent = under.title;
    back.setAttribute("aria-label", `Back to ${under.title}`);
  }

  /** Covered pages stay laid out (scroll kept) but can't be seen, tapped or read by VoiceOver. */
  const cover = (p: Page, on: boolean) => {
    p.el.classList.toggle("m-covered", on);
    p.el.inert = on;
  };

  const slide = (el: HTMLElement, from: number, to: number, duration = DURATION) => {
    if (reduced()) return Promise.resolve();
    const w = root.clientWidth;
    return el
      .animate([{ transform: `translateX(${from * w}px)` }, { transform: `translateX(${to * w}px)` }], {
        duration,
        easing: EASE,
      })
      .finished.catch(() => {});
  };

  async function push(p: Page, animate = true) {
    const under = pages.at(-1);
    pages.push(p);
    backLabel(p);
    root.append(p.el);
    if (!under) return;
    if (animate && !moving) {
      moving = true;
      await Promise.all([slide(p.el, 1, 0), slide(under.el, 0, -UNDER)]);
      moving = false;
    }
    cover(under, true);
  }

  /** Pops the top page. `from` is where a swipe let go of it, as a share of the width. */
  async function pop(from = 0) {
    if (pages.length < 2 || (moving && !from)) return;
    moving = true;
    const top = pages.pop()!;
    const under = pages.at(-1)!;
    cover(under, false);
    const rest = 1 - from;
    await Promise.all([
      slide(top.el, from, 1, DURATION * Math.max(0.4, rest)),
      slide(under.el, -UNDER * rest, 0, DURATION * Math.max(0.4, rest)),
    ]);
    top.el.style.transform = under.el.style.transform = "";
    top.el.remove();
    moving = false;
    top.onClose?.();
  }

  /** Pops everything above `p`, without animating. */
  function popTo(p: Page) {
    while (pages.length && pages.at(-1) !== p) {
      const top = pages.pop()!;
      top.el.remove();
      top.onClose?.();
    }
    if (pages.at(-1)) cover(pages.at(-1)!, false);
  }

  // Swipe back: a touch that starts at the left edge drags the top page with it, and the page underneath follows at
  // its parallax speed. Let go past a third of the way, or with a flick, and it pops; otherwise it springs back.
  root.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" || e.clientX > 24 || pages.length < 2 || moving) return;
    const top = pages.at(-1)!;
    const under = pages.at(-2)!;
    const w = root.clientWidth;
    const x0 = e.clientX;
    const y0 = e.clientY;
    let dragging = false;
    let last = { x: x0, t: e.timeStamp };
    let speed = 0;
    const move = (ev: PointerEvent) => {
      const dx = Math.max(0, ev.clientX - x0);
      if (!dragging) {
        if (Math.abs(ev.clientY - y0) > 10) return end();
        if (dx < 8) return;
        dragging = true;
        root.setPointerCapture(ev.pointerId);
        under.el.classList.remove("m-covered");
      }
      speed = (ev.clientX - last.x) / Math.max(1, ev.timeStamp - last.t);
      last = { x: ev.clientX, t: ev.timeStamp };
      top.el.style.transform = `translateX(${dx}px)`;
      under.el.style.transform = `translateX(${-UNDER * (w - dx)}px)`;
    };
    const up = (ev: PointerEvent) => {
      end();
      if (!dragging) return;
      const f = Math.max(0, ev.clientX - x0) / w;
      if (f > 0.35 || speed > 0.5) return void pop(f);
      moving = true;
      top.el.style.transform = under.el.style.transform = "";
      void Promise.all([slide(top.el, f, 0, 300), slide(under.el, -UNDER * (1 - f), -UNDER, 300)]).then(() => {
        cover(under, true);
        moving = false;
      });
    };
    const end = () => {
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerup", up);
      root.removeEventListener("pointercancel", up);
    };
    root.addEventListener("pointermove", move);
    root.addEventListener("pointerup", up);
    root.addEventListener("pointercancel", up);
  });

  return { pages, page, push, pop, popTo, top: () => pages.at(-1) };
}

/** A bar button with an icon and a VoiceOver label. */
export const barButton = (action: string, icon: string, label: string) =>
  `<button type="button" class="m-icon" data-act="${action}" aria-label="${esc(label)}"><i class="${iconClass(icon)}" aria-hidden="true"></i></button>`;

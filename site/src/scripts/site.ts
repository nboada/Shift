import Lenis from "lenis";

// Light / dark switch for the drawn app, remembered per visitor.
(() => {
  const buttons = document.querySelectorAll("[data-app-theme]");
  const apply = (theme) => {
    document.documentElement.dataset.app = theme;
    buttons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.appTheme === theme)));
  };
  try {
    const saved = localStorage.getItem("shift-site-app-theme");
    if (saved === "dark" || saved === "light") apply(saved);
  } catch {}
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      apply(b.dataset.appTheme);
      try {
        localStorage.setItem("shift-site-app-theme", b.dataset.appTheme);
      } catch {}
    }),
  );
})();

// Smooth scrolling (Lenis), off for visitors who ask for reduced motion.
if (!matchMedia("(prefers-reduced-motion: reduce)").matches) {
  new Lenis({ autoRaf: true, anchors: { offset: -72 } });
}

// The hero's Split / Wide switch: shows the app in the layout picked.
(() => {
  const stage = document.querySelector(".hero-stage");
  const buttons = document.querySelectorAll("[data-layout]:is(button)");
  buttons.forEach((b) =>
    b.addEventListener("click", () => {
      stage.dataset.layout = b.dataset.layout;
      buttons.forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
    }),
  );
})();

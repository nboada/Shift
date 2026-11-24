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

// Plays the ⌘K palette: types a few searches and shows the matching commands, like the app does.
(() => {
  const palette = document.querySelector(".palette");
  if (!palette || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const query = palette.querySelector(".query");
  const list = palette.querySelector(".cmds");

  // Labels and default keys from src/keys.ts.
  const COMMANDS = [
    ["New email", "pencil-simple", "C"],
    ["Search", "magnifying-glass", "/"],
    ["Check for mail", "arrows-clockwise", "⌘R"],
    ["Archive", "archive", "E"],
    ["Delete", "trash", "⌫"],
    ["Mark read / unread", "envelope-simple-open", "U"],
    ["Pin", "push-pin", "D"],
    ["Reply", "arrow-u-up-left", "R"],
    ["Reply all", "arrow-bend-double-up-left", "⇧R"],
    ["Forward", "arrow-u-up-right", "F"],
    ["Label", "tag", "L"],
    ["Move to", "folder-simple", "V"],
    ["Spam", "warning-octagon", "!"],
    ["Settings", "gear-six", "⌘,"],
    ["Undo", "arrow-counter-clockwise", "⌘Z"],
  ];
  const SEARCHES = ["arc", "rep", "lab", "mov", "und"];
  const ROWS = 4;

  // Word starts rank above matches inside a word, as in the app's palette.
  const matches = (q) =>
    COMMANDS.map((c) => {
      const label = c[0].toLowerCase();
      const at = label.indexOf(q);
      const wordStart = at === 0 || label[at - 1] === " ";
      return { c, score: at < 0 ? -1 : wordStart ? 2 : 1 };
    })
      .filter((m) => m.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((m) => m.c);

  // Every command stays in the list; a search only moves rows and fades them in or out, so changes glide.
  list.innerHTML =
    '<div class="cmd-hl"></div>' +
    COMMANDS.map(
      ([label, icon, key]) =>
        `<div class="cmd"><i class="ph ph-${icon}" aria-hidden="true"></i>${label}<kbd>${key}</kbd></div>`,
    ).join("");
  list.classList.add("live");
  const rows = new Map(COMMANDS.map((c, i) => [c, list.children[i + 1]]));
  const highlight = list.firstElementChild;

  const render = (q, pressed = false) => {
    query.textContent = q || "Type a command";
    query.classList.toggle("empty", !q);
    const shown = matches(q.toLowerCase()).slice(0, ROWS);
    for (const [c, row] of rows) {
      const i = shown.indexOf(c);
      row.classList.toggle("out", i < 0);
      row.classList.toggle("on", i === 0);
      if (i >= 0) row.dataset.slot = i;
    }
    highlight.classList.toggle("pressed", pressed);
  };

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  let running = false;

  async function play() {
    running = true;
    for (let n = 0; ; n++) {
      const word = SEARCHES[n % SEARCHES.length];
      for (let i = 1; i <= word.length; i++) {
        render(word.slice(0, i));
        await wait(140 + Math.random() * 80);
      }
      await wait(900);
      render(word, true);
      await wait(500);
      render("");
      await wait(900);
    }
  }

  new IntersectionObserver((entries, obs) => {
    if (entries[0].isIntersecting && !running) {
      obs.disconnect();
      render("");
      play();
    }
  }).observe(palette);
})();

// Early access: the button opens an email field; a saved email reveals the download.
(() => {
  const blocks = [...document.querySelectorAll("[data-get]")];
  const open = (block) => {
    block.querySelector("[data-get-open]").hidden = true;
    const form = block.querySelector("form");
    if (!form.hidden) return;
    form.hidden = false;
    form.querySelector("input[type=email]").focus({ preventScroll: true });
  };
  for (const block of blocks) {
    const form = block.querySelector("form");
    const msg = block.querySelector(".get-msg");
    const submit = form.querySelector("button");
    block.querySelector("[data-get-open]").addEventListener("click", () => open(block));
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      const email = form.email.value.trim();
      msg.classList.remove("error");
      if (!form.email.checkValidity() || !email) {
        msg.classList.add("error");
        msg.textContent = "Enter a valid email address.";
        return;
      }
      submit.disabled = true;
      msg.textContent = "";
      try {
        const res = await fetch("/api/early-access", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ email, website: form.website.value }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        form.hidden = true;
        if (data.download) {
          const link = block.querySelector("[data-get-download]");
          link.href = data.download;
          link.hidden = false;
          msg.textContent = "Thanks. Your download is ready.";
        } else {
          msg.textContent = "Thanks. We'll email you as soon as the download is ready.";
        }
      } catch (err) {
        msg.classList.add("error");
        msg.textContent = err.message || "Couldn't save your email. Check your connection and try again.";
      } finally {
        submit.disabled = false;
      }
    });
  }
  // The header and footer "Early access" links scroll to the hero and open its field.
  document.querySelectorAll('a[href="/#get"]').forEach((a) =>
    a.addEventListener("click", () => blocks[0] && open(blocks[0])),
  );
  if (location.hash === "#get" && blocks[0]) open(blocks[0]);
})();

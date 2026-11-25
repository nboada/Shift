// First-run walkthrough, shown once after the first sign-in as a card over the (dimmed) inbox, so layout and theme
// choices show live behind it while the first sync runs. Sign-in itself stays on the #signin screen.
import { invoke } from "@tauri-apps/api/core";
import { iconHtml } from "./icons";
import { accountSettings, setSetting, settings } from "./settings";

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Context = {
  accounts: () => string[];
  addAccount: () => Promise<void>;
  keyLabel: (action: string) => string | undefined;
};

const STEPS = ["accounts", "look", "notify", "keys"] as const;
type Step = (typeof STEPS)[number];

const root = () => document.getElementById("onboarding")!;
let ctx: Context;
let step: Step = "accounts";

export function onboardingDue() {
  return !settings.onboarding.done;
}

export function startOnboarding(context: Context) {
  ctx = context;
  step = "accounts";
  root().hidden = false;
  render();
}

function finish() {
  setSetting("onboarding.done", true);
  root().hidden = true;
  root().innerHTML = "";
}

// Small drawings of what each choice looks like (layout blocks, theme swatches), so the options read at a glance.
const PREVIEWS: Record<string, string> = {
  split: `<span class="ob-mini split"><i></i><i></i><i></i></span>`,
  wide: `<span class="ob-mini wide"><i></i><i></i></span>`,
  system: `<span class="ob-swatch system"></span>`,
  light: `<span class="ob-swatch light"></span>`,
  dark: `<span class="ob-swatch dark"></span>`,
};

const choice = (path: string, value: string, label: string, current: string) =>
  `<button type="button" class="ob-choice${current === value ? " on" : ""}" data-path="${path}" data-value="${value}" aria-pressed="${current === value}">
    ${PREVIEWS[value]}<span>${label}</span></button>`;

const switchRow = (id: string, icon: string, label: string, hint: string, checked: boolean) =>
  `<label class="ob-row">${iconHtml(icon)}<span><strong>${label}</strong><small>${hint}</small></span>
    <input type="checkbox" class="switch" role="switch" id="${id}" ${checked ? "checked" : ""} /></label>`;

const HEAD: Record<Step, [icon: string, title: string, lede: string]> = {
  accounts: [
    "users",
    "Your accounts",
    "Every Gmail account in one inbox, each with its own colour. Add the rest now, or later in Settings.",
  ],
  look: [
    "palette",
    "Make it yours",
    "Pick a layout and a theme. You'll see them on your inbox right away, and can change them in Settings.",
  ],
  notify: [
    "bell",
    "Stay in the loop",
    "Shift tells you about new Inbox mail. Closing the window keeps it running in the Dock.",
  ],
  keys: [
    "keyboard",
    "Fly through your inbox",
    "Everything works from the keyboard. Start with these; Settings → Shortcuts changes any of them.",
  ],
};

const views: Record<Step, () => string> = {
  accounts: () => `
    <ul class="ob-accounts">${ctx
      .accounts()
      .map((a) => {
        const name = accountSettings(a).title || a;
        return `<li><span class="account-avatar acct-${accountSettings(a).color}">${esc(name[0]?.toUpperCase() ?? "?")}</span><span>${esc(name)}</span>${iconHtml("circle-check")}</li>`;
      })
      .join("")}</ul>
    <button type="button" class="ob-add" data-cmd="add">${iconHtml("plus")} Add another account</button>
    <p class="ob-note" id="ob-status"></p>`,
  look: () => `
    <h3>Layout</h3>
    <div class="ob-choices">${choice("appearance.layout", "split", "Split", settings.appearance.layout)}${choice("appearance.layout", "wide", "Wide list", settings.appearance.layout)}</div>
    <h3>Theme</h3>
    <div class="ob-choices">${choice("appearance.theme", "system", "System", settings.appearance.theme)}${choice("appearance.theme", "light", "Light", settings.appearance.theme)}${choice("appearance.theme", "dark", "Dark", settings.appearance.theme)}</div>`,
  notify: () => `
    <div class="ob-rows">
      ${switchRow("ob-notify", "bell", "New mail notifications", "For Inbox mail that arrives while Shift is open", settings.notifications.enabled)}
      ${switchRow("ob-sound", "volume", "Play a sound", "With each notification", settings.notifications.sound)}
      ${switchRow("ob-login", "power", "Open Shift at login", "Starts hidden in the Dock", false)}
    </div>
    <button type="button" class="ob-add" data-cmd="test">${iconHtml("send")} Send a test notification</button>
    <p class="ob-note" id="ob-status"></p>`,
  keys: () => {
    const keys: [string, string][] = [
      ["archive", "Archive"],
      ["trash", "Delete"],
      ["reply", "Reply"],
      ["compose", "New email"],
      ["next", "Next email"],
      ["prev", "Previous email"],
      ["palette", "Every command"],
      ["undo", "Undo"],
    ];
    return `<ul class="ob-keys">${keys
      .filter(([a]) => ctx.keyLabel(a))
      .map(([a, label]) => `<li><kbd>${esc(ctx.keyLabel(a)!)}</kbd><span>${label}</span></li>`)
      .join("")}</ul>`;
  },
};

// The card is built once and only its contents change between steps, so it doesn't re-animate in on every step.
function render() {
  const i = STEPS.indexOf(step);
  if (!root().querySelector(".ob-card")) {
    root().innerHTML = `<div class="ob-card" role="dialog" aria-modal="true" aria-labelledby="ob-title">
      <div class="ob-progress" aria-hidden="true"><span></span></div>
      <div class="ob-step"></div>
      <footer></footer>
    </div>`;
  }
  const [icon, title, lede] = HEAD[step];
  root().querySelector<HTMLElement>(".ob-progress span")!.dataset.step = String(i + 1);
  const page = root().querySelector<HTMLElement>(".ob-step")!;
  page.innerHTML = `
    <header class="ob-head">
      <span class="ob-badge">${iconHtml(icon)}</span>
      <small>Step ${i + 1} of ${STEPS.length}</small>
      <h2 id="ob-title">${title}</h2>
      <p>${lede}</p>
    </header>
    <div class="ob-body">${views[step]()}</div>`;
  // Restarts the entrance animation for the new step's contents.
  page.classList.remove("in");
  void page.offsetWidth;
  page.classList.add("in");
  root().querySelector("footer")!.innerHTML = `
    ${i > 0 ? `<button type="button" class="ob-back" data-cmd="back">${iconHtml("arrow-left")} Back</button>` : `<button type="button" class="ob-back" data-cmd="skip">Skip setup</button>`}
    <button type="button" class="primary ob-next" data-cmd="next">${i === STEPS.length - 1 ? "Start using Shift" : `Continue ${iconHtml("arrow-right")}`}</button>`;
  if (step === "notify") {
    // macOS owns the login item, so the switch shows the real state.
    void invoke<boolean>("open_at_login").then(
      (on) => ((document.getElementById("ob-login") as HTMLInputElement).checked = on),
      () => {},
    );
  }
  root().querySelector<HTMLElement>(".ob-next")!.focus();
}

const status = (text: string) => {
  const el = document.getElementById("ob-status");
  if (el) el.textContent = text;
};

export function initOnboarding() {
  root().addEventListener("click", async (e) => {
    const b = (e.target as Element).closest<HTMLElement>("button");
    if (!b) return;
    if (b.dataset.path) {
      setSetting(b.dataset.path, b.dataset.value);
      return render();
    }
    const i = STEPS.indexOf(step);
    switch (b.dataset.cmd) {
      case "next":
        if (i === STEPS.length - 1) return finish();
        step = STEPS[i + 1];
        return render();
      case "back":
        step = STEPS[i - 1];
        return render();
      case "skip":
        return finish();
      case "add":
        status("Finish signing in in your browser…");
        await ctx.addAccount();
        return render();
      case "test":
        try {
          await invoke("test_notification");
          status("Sent. If nothing showed, allow Shift in System Settings → Notifications.");
        } catch (err) {
          status(String(err));
        }
    }
  });
  root().addEventListener("change", (e) => {
    const box = e.target as HTMLInputElement;
    if (box.id === "ob-notify") setSetting("notifications.enabled", box.checked);
    if (box.id === "ob-sound") setSetting("notifications.sound", box.checked);
    if (box.id === "ob-login") {
      void invoke("set_open_at_login", { enabled: box.checked }).catch((err) => {
        box.checked = !box.checked;
        status(String(err));
      });
    }
  });
  root().addEventListener("keydown", (e) => {
    // Keeps the app's single-key shortcuts from acting behind the card.
    e.stopPropagation();
    if (e.key === "Escape") finish();
  });
}

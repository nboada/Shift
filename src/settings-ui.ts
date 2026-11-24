import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ask } from "./dialog";
import { ACTIONS, comboOf, formatCombo, keysFor } from "./keys";
import {
  ACCOUNT_COLORS, AI_PROVIDERS, DEFAULTS, ZOOM_STEPS, accountSettings, getSetting, setAccountSetting, setSetting, settings,
} from "./settings";

const SECTIONS: [string, string, string][] = [
  ["general", "General", "gear-six"],
  ["appearance", "Appearance", "palette"],
  ["accounts", "Accounts", "user-circle"],
  ["ai", "AI", "sparkle"],
  ["notifications", "Notifications", "bell"],
  ["scheduling", "Scheduling", "calendar-blank"],
  ["inbox", "Inbox", "tray"],
  ["composer", "Composer", "pencil-simple-line"],
  ["accessibility", "Accessibility", "text-aa"],
  ["swipes", "Swipes", "hand-swipe-left"],
  ["shortcuts", "Keyboard shortcuts", "keyboard"],
];

const SWIPE_ACTIONS: [string, string][] = [
  ["none", "Nothing"], ["archive", "Archive"], ["trash", "Delete"], ["unread", "Mark read / unread"], ["star", "Pin / unpin"], ["spam", "Spam"],
];

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

type Ctx = { accounts: () => string[]; onAddAccount: () => Promise<void>; onSignOut: (email: string) => void };
let ctx: Ctx;
let current = "general";
let accountOpen: string | null = null;
const root = () => document.getElementById("settings")!;
const panel = () => document.getElementById("settings-panel")!;

// ---- control builders: each control carries its settings path; one listener saves them all ----

/** Options per dropdown path, kept from the last render so the popup can list them. */
const dropdownOptions = new Map<string, [string | number, string][]>();

/** Shift-styled dropdown: a button showing the current choice that opens a menu (see openDropdown). */
function select(path: string, options: [string | number, string][], disabled = false) {
  dropdownOptions.set(path, options);
  const value = String(getSetting(path));
  const label = options.find(([v]) => String(v) === value)?.[1] ?? value;
  return `<button type="button" class="dropdown" data-dropdown="${path}" aria-haspopup="listbox" aria-expanded="false" ${disabled ? "disabled" : ""}>
    <span>${esc(label)}</span><i class="ph ph-caret-up-down"></i></button>`;
}

const popup = document.createElement("div");
popup.className = "menu dropdown-menu";
popup.setAttribute("role", "listbox");
popup.hidden = true;
document.body.append(popup);
let popupFor: HTMLButtonElement | null = null;

function closeDropdown(refocus = false) {
  if (popup.hidden) return;
  popup.hidden = true;
  popupFor?.setAttribute("aria-expanded", "false");
  if (refocus) popupFor?.focus();
  popupFor = null;
}

function openDropdown(button: HTMLButtonElement, pick: (value: string | number) => void) {
  if (popupFor === button) return closeDropdown();
  closeDropdown();
  const path = button.dataset.dropdown!;
  const options = dropdownOptions.get(path) ?? [];
  const value = String(getSetting(path));
  popup.innerHTML = options
    .map(([v, label], i) => `<button type="button" role="option" data-i="${i}" aria-selected="${String(v) === value}">
      <i class="ph ph-check"></i><span>${esc(label)}</span></button>`)
    .join("");
  popup.onclick = (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-i]");
    if (!b) return;
    const v = options[Number(b.dataset.i)][0];
    closeDropdown(true);
    pick(v);
  };
  const r = button.getBoundingClientRect();
  popup.hidden = false;
  popup.style.minWidth = `${r.width}px`;
  popup.style.left = `${Math.max(8, Math.min(r.right - popup.offsetWidth, window.innerWidth - popup.offsetWidth - 8))}px`;
  const below = r.bottom + 6 + popup.offsetHeight < window.innerHeight;
  popup.style.top = `${below ? r.bottom + 6 : r.top - 6 - popup.offsetHeight}px`;
  button.setAttribute("aria-expanded", "true");
  popupFor = button;
  (popup.querySelector<HTMLElement>('[aria-selected="true"]') ?? popup.querySelector<HTMLElement>("button"))?.focus();
}

popup.addEventListener("keydown", (e) => {
  const items = [...popup.querySelectorAll<HTMLButtonElement>("button")];
  const i = items.indexOf(document.activeElement as HTMLButtonElement);
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    items[(i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
  } else if (e.key === "Escape" || e.key === "Tab") {
    e.preventDefault();
    e.stopPropagation(); // don't also close Settings
    closeDropdown(true);
  }
});
document.addEventListener("pointerdown", (e) => {
  if (!popup.hidden && !popup.contains(e.target as Node) && !popupFor?.contains(e.target as Node)) closeDropdown();
});

/** Segmented control for short option lists: every choice visible, one click to pick. */
function segmented(path: string, options: [string | number, string, string?][], disabled = false) {
  const value = String(getSetting(path));
  const numeric = typeof getSetting(path) === "number";
  // Buttons with role="radio" rather than hidden radio inputs: every click (mouse, keyboard, assistive tech) reaches us.
  return `<div class="segmented" role="radiogroup"><span class="seg-thumb" aria-hidden="true"></span>${options
    .map(([v, label, icon]) => {
      const on = String(v) === value;
      return `<button type="button" role="radio" aria-checked="${on}" class="${on ? "on" : ""}" data-pick="${path}" data-value="${esc(String(v))}" ${numeric ? 'data-number="1"' : ""} ${disabled ? "disabled" : ""}>${icon ? `<i class="ph ph-${icon}"></i>` : ""}<span>${esc(label)}</span></button>`;
    })
    .join("")}</div>`;
}

/** Moves each segmented control's sliding highlight under its selected option. */
function placeThumbs() {
  panel().querySelectorAll<HTMLElement>(".segmented").forEach((seg) => {
    const on = seg.querySelector<HTMLElement>("button.on");
    if (!on) return;
    seg.style.setProperty("--thumb-x", `${on.offsetLeft}px`);
    seg.style.setProperty("--thumb-w", `${on.offsetWidth}px`);
    // Only animate after the first placement, so opening a section doesn't slide in from the edge.
    requestAnimationFrame(() => seg.classList.add("ready"));
  });
}

function toggle(path: string, disabled = false) {
  return `<input type="checkbox" class="switch" role="switch" data-path="${path}" ${getSetting(path) ? "checked" : ""} ${disabled ? "disabled" : ""} />`;
}

function row(title: string, control: string, desc = "") {
  return `<div class="setting-row"><div class="setting-text"><strong>${title}</strong>${desc ? `<span>${desc}</span>` : ""}</div><div class="setting-control">${control}</div></div>`;
}

const group = (title: string, rows: string) => `<section class="setting-group">${title ? `<h3>${title}</h3>` : ""}${rows}</section>`;
const soon = (what: string) => `<p class="soon"><i class="ph ph-hourglass-medium"></i>Coming soon: ${what} These options are saved now and take effect when it ships.</p>`;

// ---- sections ----

function accountDetail(email: string) {
  const a = accountSettings(email);
  const link = (icon: string, label: string, where: string, target?: string) =>
    `<button class="more-link" ${target ? `data-cmd="goto" data-target="${target}"` : "disabled"}><i class="ph ph-${icon}"></i><span>${label}</span>${
      target ? `<em>in ${where}</em><i class="ph ph-caret-right"></i>` : `<em>${where}</em>`}</button>`;
  return `<button class="back-link" data-cmd="close-account"><i class="ph ph-arrow-left"></i>All accounts</button>
    <h3 class="account-heading">${esc(email)}</h3>` +
    group("", row("Sender's name", `<input type="text" data-account-key="name" value="${esc(a.name)}" placeholder="Your name" />`, "Your name shown to recipients.") +
      row("Account title", `<input type="text" data-account-key="title" value="${esc(a.title)}" placeholder="e.g. Work" />`, "Only you see it, in the sidebar.") +
      row("Colour", `<div class="swatches" role="radiogroup">${ACCOUNT_COLORS.map((c) =>
        `<button type="button" role="radio" class="swatch acct-${c}" aria-label="${c}" aria-checked="${c === a.color}" data-pick-account="color" data-value="${c}"></button>`).join("")}</div>`, "Marks this account in the sidebar.") +
      row("Show in unified inbox", `<input type="checkbox" class="switch" role="switch" data-account-key="unified" ${a.unified ? "checked" : ""} />`, "Include this account in “All accounts”.")) +
    `<h3 class="group-title">More</h3>` +
    group("", link("signature", "Signatures", "Composer", "composer") + link("bell", "Notifications", "Notifications", "notifications") +
      link("at", "Aliases", "Coming soon") + link("folder", "Folders", "Coming soon") + link("app-store-logo", "App icon badge", "Coming soon")) +
    `<div class="account-actions"><button class="secondary danger" data-cmd="signout">Log out</button></div>`;
}

const render: Record<string, () => string> = {
  accounts: () => {
    if (accountOpen) return accountDetail(accountOpen);
    const rows = ctx.accounts().map((email) => {
      const a = accountSettings(email);
      return `<button class="account-row" data-cmd="open-account" data-email="${esc(email)}">
        <span class="account-avatar acct-${a.color}">${esc((a.title || email).charAt(0).toUpperCase())}</span>
        <span class="setting-text"><strong>${esc(a.title || email)}</strong><span>${a.title ? `${esc(email)} · ` : ""}Gmail</span></span>
        <i class="ph ph-caret-right"></i>
      </button>`;
    });
    return group("", rows.join("")) +
      group("", row("Add a Google account", `<button class="secondary" data-cmd="add-account"><i class="ph ph-plus"></i> Add account</button>`,
        "Sign in with Google in your browser. Mail is stored on this Mac."));
  },

  ai: () => {
    const p = AI_PROVIDERS.find((x) => x.id === settings.ai.provider) ?? AI_PROVIDERS[0];
    const custom = !p.models.length || settings.ai.model === "custom";
    const models: [string, string][] = [...p.models.map((m): [string, string] => [m, m]), ["custom", "Custom model…"]];
    return soon("AI features in Shift (summaries, drafting, smart replies).") +
      group("Provider", row("Provider", select("ai.provider", AI_PROVIDERS.map((x) => [x.id, x.name])), "Use your own account with any of these.") +
        (p.models.length ? row("Model", select("ai.model", models)) : "") +
        (custom ? row("Model name", `<input type="text" data-path="ai.customModel" value="${esc(settings.ai.customModel)}" placeholder="${p.id === "openrouter" ? "provider/model" : p.id === "ollama" ? "e.g. a model you've pulled" : "model-id"}" spellcheck="false" />`, "Exactly as the provider names it.") : "") +
        (p.baseUrl !== undefined ? row("Server URL", `<input type="url" data-path="ai.baseUrl" value="${esc(settings.ai.baseUrl || p.baseUrl)}" placeholder="https://…/v1" spellcheck="false" />`, p.id === "ollama" ? "Where Ollama is running." : "OpenAI-compatible endpoint.") : "")) +
      (p.needsKey ? group("API key", `<div class="setting-row"><div class="setting-text"><strong>API key</strong><span id="ai-key-status">Checking…</span></div>
          <div class="setting-control key-control"><input type="password" id="ai-key" placeholder="Paste your key" autocomplete="off" spellcheck="false" />
          <button class="secondary" data-cmd="save-key">Save</button><button class="secondary" data-cmd="delete-key" hidden>Remove</button></div></div>` +
        (p.keyUrl ? `<p class="hint">Stored in the macOS Keychain, never in a file. <a href="${p.keyUrl}" data-cmd="open-link">Get a ${esc(p.name)} key</a></p>` : `<p class="hint">Stored in the macOS Keychain, never in a file.</p>`)) : "");
  },

  general: () =>
    group("Sync", row("Check for new mail", select("general.syncSeconds", [[15, "Every 15 seconds"], [30, "Every 30 seconds"], [60, "Every minute"], [300, "Every 5 minutes"], [900, "Every 15 minutes"]]), "Opened mail always loads from this Mac instantly.")) +
    group("Reading", row("Mark as read when opened", toggle("general.markReadOnOpen")) +
      row("Ask before deleting", toggle("general.confirmDelete"))),

  appearance: () =>
    group("Theme", row("Appearance", segmented("appearance.theme", [["system", "System", "desktop"], ["light", "Light", "sun"], ["dark", "Dark", "moon"]]))) +
    group("Message list", row("Density", segmented("appearance.density", [["comfortable", "Comfortable"], ["compact", "Compact"]])) +
      row("Show avatars", toggle("appearance.showAvatars")) +
      row("Preview lines", segmented("appearance.snippetLines", [[0, "None"], [1, "1"], [2, "2"]]))),

  notifications: () =>
    soon("desktop notifications for new mail.") +
    group("", row("New mail notifications", toggle("notifications.enabled", true)) +
      row("Play a sound", toggle("notifications.sound", true)) +
      row("Only from people", toggle("notifications.onlyPeople", true), "Skip newsletters and automated mail.")),

  scheduling: () =>
    group("Send later", row("Later today", select("scheduling.laterTodayHours", [[1, "In 1 hour"], [2, "In 2 hours"], [3, "In 3 hours"], [4, "In 4 hours"]])) +
      row("Mornings start at", `<input type="time" data-path="scheduling.morning" value="${esc(settings.scheduling.morning)}" />`, "Used for Tomorrow, This weekend and Next week.") +
      row("This weekend", segmented("scheduling.weekendDay", [["saturday", "Saturday"], ["sunday", "Sunday"]])) +
      row("Next week", segmented("scheduling.nextWeekDay", [["monday", "Monday"], ["sunday", "Sunday"]]))) +
    `<p class="hint">Scheduled emails wait in Gmail Drafts and are sent by Shift, so it needs to be open at the send time. If it isn't, they go out the next time it opens.</p>`,

  inbox: () =>
    group("Layout", row("Inbox view", segmented("inbox.view", [["smart", "Smart Inbox", "stack"], ["list", "Plain list", "list"]]), "Smart Inbox groups mail into sections; plain list is newest first.")) +
    group("Smart Inbox", row("Pinned at the top", toggle("inbox.pinnedOnTop")) +
      row("Split unread into People and Notifications", toggle("inbox.splitUnread"), "Notifications are Gmail's Promotions, Updates, Social and Forums.")) +
    group("Sidebar", row("Show unread count", toggle("inbox.unreadBadge"))),

  composer: () =>
    group("Signature", row("Format", segmented("composer.signatureMode", [["text", "Plain text"], ["html", "HTML"]]), "Added to new emails, replies and forwards.") +
      (settings.composer.signatureMode === "html"
        ? `<textarea class="code" data-path="composer.signatureHtml" rows="7" spellcheck="false" placeholder="<p><strong>Your Name</strong><br>Company · +61 …</p>">${esc(settings.composer.signatureHtml)}</textarea>
           <div class="sig-preview"><span>Preview</span><iframe id="sig-preview" sandbox="allow-same-origin" title="Signature preview"></iframe></div>`
        : `<textarea data-path="composer.signature" rows="4" placeholder="Your name, role, phone…">${esc(settings.composer.signature)}</textarea>`)) +
    group("Replying", row("Default reply", segmented("composer.defaultReply", [["reply", "Reply"], ["all", "Reply all"]]), "What R and ⌘R do. The other is always ⇧R.") +
      row("Quote the original message", toggle("composer.quoteOriginal"))) +
    group("Sending", row("Undo send", segmented("composer.undoSendSeconds", [[0, "Off"], [5, "5s"], [10, "10s"], [20, "20s"]]), "Wait before sending so you can take it back.")),

  accessibility: () =>
    group("Zoom", row("Zoom", select("accessibility.zoom", ZOOM_STEPS.map((z): [number, string] => [z, `${z}%`])), "Also ⌘+ ⌘− and ⌘0.")) +
    group("Motion", row("Reduce motion", toggle("accessibility.reduceMotion"), "Turns off animations and transitions.")),

  swipes: () =>
    group("Two-finger swipe on the message list", row("Swipe left", select("swipes.left", SWIPE_ACTIONS)) + row("Swipe right", select("swipes.right", SWIPE_ACTIONS))) +
    `<p class="hint">Swipe a row sideways on the trackpad, or drag it on a touch screen.</p>`,

  shortcuts: () => {
    const keys = keysFor(settings.shortcuts);
    return `<div class="shortcut-head"><p class="hint">Click + to record a key. Single keys work like Spark, ⌘ combinations like Apple Mail.</p>
        <button class="secondary" data-cmd="reset-keys">Reset all</button></div>` +
      group("", ACTIONS.map(([action, label]) => row(label, `<div class="chips">${keys[action]
        .map((c) => `<span class="chip"><kbd>${esc(formatCombo(c))}</kbd><button data-cmd="remove-key" data-action="${action}" data-combo="${esc(c)}" aria-label="Remove ${esc(formatCombo(c))}"><i class="ph ph-x"></i></button></span>`)
        .join("")}<button class="chip-add" data-cmd="record" data-action="${action}" aria-label="Add a key for ${label}"><i class="ph ph-plus"></i></button>${
        settings.shortcuts[action] ? `<button class="chip-add" data-cmd="reset-key" data-action="${action}" data-tip="Reset to default"><i class="ph ph-arrow-counter-clockwise"></i></button>` : ""}</div>`)).join("")) +
      `<p class="hint" id="shortcut-note"></p>`;
  },
};

function show(section: string) {
  const switching = section !== current;
  if (section !== current) accountOpen = null;
  current = section;
  // Fade content in only when the section changes; edits that re-render it (e.g. recording a key) stay still.
  panel().classList.toggle("switching", switching);
  root().querySelectorAll<HTMLElement>("[data-section]").forEach((b) => b.classList.toggle("active", b.dataset.section === section));
  document.getElementById("settings-title")!.textContent = SECTIONS.find(([id]) => id === section)![1];
  panel().innerHTML = render[section]();
  placeThumbs();
  if (section === "ai") refreshKeyStatus();
  if (section === "composer") renderSignaturePreview();
}

/** Live preview of the HTML signature. Sandboxed without scripts, so pasted markup can't run code. */
export function renderSignaturePreview(frame = document.getElementById("sig-preview") as HTMLIFrameElement | null) {
  if (!frame) return;
  frame.onload = () => (frame.style.height = `${frame.contentDocument?.documentElement.scrollHeight ?? 60}px`);
  frame.srcdoc = `<style>body{margin:0;padding:10px 12px;font:14px/1.5 -apple-system,system-ui,sans-serif;color:#1d1d1f}</style>${
    settings.composer.signatureHtml || '<span style="color:#999">Nothing yet</span>'}`;
}

async function refreshKeyStatus() {
  const status = document.getElementById("ai-key-status");
  if (!status) return;
  const has = await invoke<boolean>("has_ai_key", { provider: settings.ai.provider });
  status.textContent = has ? "Saved in Keychain" : "Not set";
  status.classList.toggle("ok", has);
  root().querySelector<HTMLElement>('[data-cmd="delete-key"]')!.hidden = !has;
}

// ---- shortcut recording: captures the next key press before the app's own shortcuts see it ----

let recording: string | null = null;
function startRecording(action: string, button: HTMLElement) {
  recording = action;
  button.classList.add("recording");
  button.innerHTML = "Press keys…";
}

window.addEventListener("keydown", async (e) => {
  if (!recording) return;
  if (["Shift", "Meta", "Control", "Alt"].includes(e.key)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  const action = recording;
  recording = null;
  if (e.key === "Escape") return show("shortcuts");
  const combo = comboOf(e);
  const keys = keysFor(settings.shortcuts);
  const owner = Object.keys(keys).find((a) => a !== action && keys[a].includes(combo));
  if (owner) {
    const label = ACTIONS.find(([a]) => a === owner)![1];
    const target = ACTIONS.find(([a]) => a === action)![1];
    const replace = await ask({
      title: `Replace ${formatCombo(combo)}?`,
      message: `${formatCombo(combo)} is already used for “${label}”. Replacing it makes ${formatCombo(combo)} do “${target}” instead.`,
      confirm: "Replace",
    });
    if (!replace) {
      show("shortcuts");
      document.getElementById("shortcut-note")!.textContent = `Kept ${formatCombo(combo)} for "${label}".`;
      return;
    }
  }
  const next = { ...settings.shortcuts };
  if (owner) next[owner] = keys[owner].filter((c) => c !== combo);
  if (!keys[action].includes(combo)) next[action] = [...keys[action], combo];
  setSetting("shortcuts", next);
  show("shortcuts");
}, true);

// ---- wiring ----

export function initSettings(c: Ctx) {
  ctx = c;
  const nav = root().querySelector(".settings-nav")!;
  nav.innerHTML = SECTIONS.map(([id, label, icon]) => `<button data-section="${id}"><i class="ph ph-${icon}"></i><span>${label}</span></button>`).join("");
  nav.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-section]");
    if (b) show(b.dataset.section!);
  });
  document.getElementById("settings-close")!.addEventListener("click", closeSettings);
  // Clicking the dimmed app around the window closes it, like a sheet.
  root().addEventListener("click", (e) => {
    if (e.target === root()) closeSettings();
  });

  const onEdit = (e: Event) => {
    const el = e.target as HTMLInputElement;
    const accountKey = el.dataset.accountKey as "name" | "title" | "color" | "unified" | undefined;
    if (accountKey && accountOpen) {
      setAccountSetting(accountOpen, accountKey, el.type === "checkbox" ? el.checked : el.value);
      return;
    }
    const path = el.dataset.path;
    if (!path) return;
    commit(path, el.type === "checkbox" ? el.checked : el.dataset.number ? Number(el.value) : el.value);
  };
  const commit = (path: string, value: unknown) => {
    setSetting(path, value);
    if (path === "ai.provider") {
      const p = AI_PROVIDERS.find((x) => x.id === value)!;
      setSetting("ai.model", p.models[0] ?? "custom");
      setSetting("ai.baseUrl", p.baseUrl ?? "");
    }
    // Re-render where one choice changes which other options make sense.
    if (path === "ai.provider" || path === "ai.model" || path === "composer.signatureMode") show(current);
    if (path === "composer.signatureHtml") renderSignaturePreview();
  };
  panel().addEventListener("change", onEdit);
  panel().addEventListener("input", (e) => {
    const el = e.target as HTMLElement;
    if (el.matches("textarea, input[type=text], input[type=url]")) onEdit(e);
  });
  panel().addEventListener("click", (e) => {
    const d = (e.target as Element).closest<HTMLButtonElement>("[data-dropdown]");
    if (!d || d.disabled) return;
    openDropdown(d, (value) => {
      d.querySelector("span")!.textContent = dropdownOptions.get(d.dataset.dropdown!)!.find(([v]) => v === value)![1];
      commit(d.dataset.dropdown!, value);
    });
  });
  panel().addEventListener("scroll", () => closeDropdown());

  // Segmented controls and colour swatches are buttons (see segmented()).
  panel().addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-pick], [data-pick-account]");
    if (!b || b.disabled) return;
    if (b.dataset.pickAccount && accountOpen) {
      setAccountSetting(accountOpen, b.dataset.pickAccount as "color", b.dataset.value!);
      return show("accounts");
    }
    b.parentElement!.querySelectorAll("button").forEach((x) => {
      x.classList.toggle("on", x === b);
      x.setAttribute("aria-checked", String(x === b));
    });
    placeThumbs();
    commit(b.dataset.pick!, b.dataset.number ? Number(b.dataset.value) : b.dataset.value);
  });

  panel().addEventListener("click", async (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-cmd]");
    if (!b) return;
    const action = b.dataset.action!;
    switch (b.dataset.cmd) {
      case "signout":
        return accountOpen && ctx.onSignOut(accountOpen);
      case "add-account": {
        const label = b.innerHTML;
        b.textContent = "Finish signing in in your browser…";
        b.setAttribute("disabled", "");
        await ctx.onAddAccount().finally(() => {
          b.innerHTML = label;
          b.removeAttribute("disabled");
        });
        return show("accounts");
      }
      case "open-account":
        accountOpen = b.dataset.email!;
        return show("accounts");
      case "close-account":
        accountOpen = null;
        return show("accounts");
      case "goto":
        return show(b.dataset.target!);
      case "open-link":
        e.preventDefault();
        return openUrl((b as HTMLAnchorElement).href);
      case "save-key": {
        const input = document.getElementById("ai-key") as HTMLInputElement;
        try {
          await invoke("set_ai_key", { provider: settings.ai.provider, key: input.value });
          input.value = "";
        } catch (err) {
          document.getElementById("ai-key-status")!.textContent = String(err);
          return;
        }
        return refreshKeyStatus();
      }
      case "delete-key":
        await invoke("delete_ai_key", { provider: settings.ai.provider });
        return refreshKeyStatus();
      case "record":
        return startRecording(action, b);
      case "remove-key": {
        const keys = keysFor(settings.shortcuts);
        setSetting("shortcuts", { ...settings.shortcuts, [action]: keys[action].filter((c) => c !== b.dataset.combo) });
        return show("shortcuts");
      }
      case "reset-key": {
        const next = { ...settings.shortcuts };
        delete next[action];
        setSetting("shortcuts", next);
        return show("shortcuts");
      }
      case "reset-keys":
        setSetting("shortcuts", structuredClone(DEFAULTS.shortcuts));
        return show("shortcuts");
    }
  });
}

export function openSettings(section = current) {
  root().classList.remove("closing");
  root().hidden = false;
  show(section);
}

const reducedMotion = () =>
  matchMedia("(prefers-reduced-motion: reduce)").matches || document.documentElement.dataset.reduceMotion === "true";

/** Plays the exit animation, then hides; instant when reduced motion is on. */
export function closeSettings() {
  recording = null;
  closeDropdown();
  const r = root();
  if (r.hidden || r.classList.contains("closing")) return;
  const done = () => {
    if (!r.classList.contains("closing")) return; // reopened mid-animation
    r.classList.remove("closing");
    r.hidden = true;
  };
  r.classList.add("closing");
  if (reducedMotion()) return done();
  r.querySelector(".settings-window")!.addEventListener("animationend", done, { once: true });
}

export const settingsOpen = () => !root().hidden && !root().classList.contains("closing");


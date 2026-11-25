import { invoke } from "@tauri-apps/api/core";

export type SwipeAction = "none" | "archive" | "trash" | "unread" | "star" | "spam";

/** Starting rules for Write with AI and Draft a reply; the user edits them in Settings → AI. */
export const DEFAULT_WRITING_RULES = `- Write in a natural, direct and specific voice. Clear meaning beats polished-sounding language.
- When rewriting my text, keep my wording, reasoning and tone. Improve clarity and flow without changing my personality.
- Match the formality of the conversation, and reply in the language it's in.
- Get to the point early, and keep it as short as the email allows.
- Vary sentence length. No strings of punchy fragments or one-sentence paragraphs.
- Use standard grammar and punctuation. No em dashes, no emojis, and no exclamation marks unless the other person uses them.
- No jargon, filler, stock phrases like "I hope this email finds you well", exaggerated claims or artificial warmth.
- In replies, don't repeat back what the sender said or asked. Acknowledge it briefly and move on.
- Never invent facts, opinions, dates, prices or commitments I haven't mentioned.`;

export const DEFAULTS = {
  general: { syncSeconds: 30, markReadOnOpen: true, confirmDelete: false },
  appearance: {
    theme: "system" as "system" | "light" | "dark",
    density: "comfortable" as "comfortable" | "compact",
    showAvatars: true,
    snippetLines: 2,
    layout: "split" as "split" | "wide",
    uniformEmailFont: true,
    loadRemoteImages: false,
  },
  notifications: { enabled: true, sound: true, onlyPeople: false },
  scheduling: { laterTodayHours: 3, morning: "09:00", weekendDay: "saturday", nextWeekDay: "monday" },
  inbox: { view: "smart" as "smart" | "list", pinnedOnTop: true, splitUnread: true, unreadBadge: true },
  composer: {
    signature: "",
    signatureMode: "text" as "text" | "html",
    signatureHtml: "",
    defaultReply: "reply" as "reply" | "all",
    replyIn: "window" as "inline" | "window",
    /** Account new emails are sent from; empty means the first account. Replies always use the thread's account. */
    defaultFrom: "",
    quoteOriginal: true,
    undoSendSeconds: 5,
  },
  accessibility: { zoom: 100, reduceMotion: false },
  /** Mailbox keys (label id, or "ALL" for All Mail) in the order and visibility the sidebar uses. */
  sidebar: { order: [] as string[], hidden: [] as string[] },
  swipes: { left: "archive" as SwipeAction, right: "unread" as SwipeAction },
  shortcuts: {} as Record<string, string[]>,
  onboarding: { done: false },
  /** Keyed by email address, so each account keeps its own options. */
  accounts: {} as Record<string, Partial<AccountSettings>>,
  ai: {
    provider: "anthropic",
    model: "claude-sonnet-5-5",
    customModel: "",
    baseUrl: "",
    autoLabel: false,
    labelRules: {} as Record<string, string>,
    writingRules: DEFAULT_WRITING_RULES,
    // Per kind of job; an empty provider means "same as the default above".
    tasks: { writing: { provider: "", model: "" }, sorting: { provider: "", model: "" } },
  },
};

export type Settings = typeof DEFAULTS;

/** Absent `signature` means the account uses the default one from Settings → Composer. */
export type AccountSettings = {
  name: string;
  title: string;
  color: string;
  unified: boolean;
  signature?: SignatureSettings;
};
export type SignatureSettings = { mode: "text" | "html"; text: string; html: string };

/** The signature for mail from `account`: its own if it has one, else the default. */
export function signatureFor(account: string | undefined, s: Settings = settings): SignatureSettings {
  const { signatureMode: mode, signature: text, signatureHtml: html } = s.composer;
  return (account && s.accounts[account]?.signature) || { mode, text, html };
}

// Shift's account colours (talkk-mail App/UI/Theme.swift); CSS classes .acct-<name> carry the hex values.
export const ACCOUNT_COLORS = ["blue", "red", "orange", "purple", "green", "pink", "teal", "yellow", "graphite"];
/** New accounts take these in turn. */
export const ACCOUNT_COLOR_ORDER = ["blue", "red", "orange", "purple", "green"];

export function accountSettings(email: string): AccountSettings {
  return { name: "", title: "", color: "blue", unified: true, ...settings.accounts[email] };
}

/** Account options live under the email address, which contains dots, so they can't use dotted paths. */
export function setAccountSetting<K extends keyof AccountSettings>(email: string, key: K, value: AccountSettings[K]) {
  settings.accounts = { ...settings.accounts, [email]: { ...settings.accounts[email], [key]: value } };
  notify("accounts");
}

/** Defaults filled in under whatever was saved, so new options appear without a migration. */
function merge<T>(base: T, saved: unknown): T {
  if (typeof base !== "object" || base === null || Array.isArray(base)) return (saved ?? base) as T;
  if (typeof saved !== "object" || saved === null) return structuredClone(base);
  const out: Record<string, unknown> = { ...(saved as object) };
  for (const [k, v] of Object.entries(base)) out[k] = merge(v, (saved as Record<string, unknown>)[k]);
  return out as T;
}

export let settings: Settings = structuredClone(DEFAULTS);
const listeners = new Set<(path: string) => void>();

/** `path` is the dotted setting that changed, or "*" after loading. */
export function onSettingsChange(fn: (path: string) => void) {
  listeners.add(fn);
}

export async function loadSettings() {
  try {
    settings = merge(DEFAULTS, await invoke("get_settings"));
  } catch {
    settings = structuredClone(DEFAULTS);
  }
  listeners.forEach((fn) => fn("*"));
}

let saveTimer = 0;
/** Sets a dotted path ("appearance.theme"), applies it immediately and saves shortly after. */
export function setSetting(path: string, value: unknown) {
  const keys = path.split(".");
  let node = settings as unknown as Record<string, unknown>;
  for (const k of keys.slice(0, -1)) node = node[k] as Record<string, unknown>;
  node[keys.at(-1)!] = value;
  notify(path);
}

let dirty = false;
let saving: Promise<void> = Promise.resolve();
let saveError: (err: unknown) => void = () => {};
/** Called when the settings file can't be written. */
export const onSaveError = (fn: (err: unknown) => void) => (saveError = fn);

function notify(path: string) {
  listeners.forEach((fn) => fn(path));
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(flushSettings, 300);
}

/** Writes pending changes now, after any write already under way, so writes land in order. Awaited before quitting. */
export function flushSettings() {
  clearTimeout(saveTimer);
  if (!dirty) return saving;
  dirty = false;
  saving = saving
    .then(() => invoke<void>("set_settings", { value: settings }))
    .catch((err) => {
      // Still unsaved: the next change or the flush before quitting tries again.
      dirty = true;
      saveError(err);
    });
  return saving;
}

export function getSetting(path: string): unknown {
  return path.split(".").reduce<unknown>((n, k) => (n as Record<string, unknown>)?.[k], settings);
}

/** Visual settings live on <html> as data attributes so CSS does the work. */
export function applyVisualSettings() {
  const root = document.documentElement;
  const { appearance, accessibility } = settings;
  if (appearance.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = appearance.theme;
  root.dataset.density = appearance.density;
  root.dataset.layout = appearance.layout;
  root.dataset.avatars = String(appearance.showAvatars);
  root.dataset.snippet = String(appearance.snippetLines);
  root.dataset.reduceMotion = String(accessibility.reduceMotion);
  root.style.setProperty("zoom", `${accessibility.zoom}%`);
}

export const ZOOM_STEPS = [75, 85, 90, 100, 110, 125, 150];

export function stepZoom(dir: -1 | 0 | 1) {
  const z = settings.accessibility.zoom;
  const next =
    dir === 0
      ? 100
      : dir > 0
        ? (ZOOM_STEPS.find((s) => s > z) ?? z)
        : ([...ZOOM_STEPS].reverse().find((s) => s < z) ?? z);
  setSetting("accessibility.zoom", next);
}

export type Provider = {
  id: string;
  name: string;
  models: string[];
  needsKey: boolean;
  baseUrl?: string;
  keyUrl?: string;
};

// Model lists checked against each provider's docs on 2026-11-24; "Custom model…" covers anything newer.
export const AI_PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    name: "Anthropic (Claude)",
    needsKey: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2"],
  },
  {
    id: "openai",
    name: "OpenAI",
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    models: ["gpt-6.2-astra", "gpt-6.2-sol", "gpt-6.1-terra", "gpt-6-luna"],
  },
  {
    id: "google",
    name: "Google Gemini",
    needsKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
    models: ["gemini-4-carbon", "gemini-4-neon", "gemini-4-hydrogen", "gemini-4-argon", "gemini-3.8-flash"],
  },
  { id: "xai", name: "xAI (Grok)", needsKey: true, keyUrl: "https://console.x.ai", models: ["grok-4.7"] },
  {
    id: "mistral",
    name: "Mistral",
    needsKey: true,
    keyUrl: "https://console.mistral.ai/api-keys",
    models: ["mistral-large-latest", "mistral-medium-latest", "mistral-small-latest"],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    needsKey: true,
    baseUrl: "https://openrouter.ai/api/v1",
    keyUrl: "https://openrouter.ai/keys",
    models: [],
  },
  { id: "ollama", name: "Ollama (local)", needsKey: false, baseUrl: "http://localhost:11434", models: [] },
  { id: "custom", name: "Custom (OpenAI-compatible)", needsKey: true, baseUrl: "", models: [] },
];

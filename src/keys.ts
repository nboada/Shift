export type KeyLike = Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">;

/** "cmd+shift+r", "shift+r", "#", "ArrowDown". Shift only counts on letters, since it already changes symbols (3 → #). */
export function comboOf(e: KeyLike) {
  const letter = /^[a-z]$/i.test(e.key);
  const mods = [e.ctrlKey && "ctrl", e.altKey && "alt", e.metaKey && "cmd", e.shiftKey && letter && "shift"].filter(Boolean);
  return [...mods, letter ? e.key.toLowerCase() : e.key].join("+");
}

/** Remappable actions, in the order the settings screen lists them. */
export const ACTIONS: [string, string][] = [
  ["compose", "New email"],
  ["search", "Search"],
  ["sync", "Check for mail"],
  ["next", "Next email"],
  ["prev", "Previous email"],
  ["archive", "Archive"],
  ["trash", "Delete"],
  ["unread", "Mark read / unread"],
  ["star", "Pin"],
  ["reply", "Reply"],
  ["replyAll", "Reply all"],
  ["forward", "Forward"],
  ["label", "Label"],
  ["move", "Move to"],
  ["spam", "Spam"],
  ["palette", "Command palette"],
  ["settings", "Settings"],
  ["zoomIn", "Zoom in"],
  ["zoomOut", "Zoom out"],
  ["zoomReset", "Actual size"],
  ["undo", "Undo archive, delete or move"],
];

/** Spark-style single keys plus Apple Mail's ⌘ shortcuts, so habits from either app work. */
export const DEFAULT_KEYS: Record<string, string[]> = {
  compose: ["c", "cmd+n"],
  search: ["/", "cmd+f"],
  sync: ["cmd+r"],
  next: ["j", "ArrowDown", "ArrowRight"],
  prev: ["k", "ArrowUp", "ArrowLeft"],
  archive: ["e", "ctrl+cmd+a"],
  trash: ["Backspace", "Delete", "#"],
  unread: ["u", "cmd+shift+u"],
  star: ["d", "cmd+shift+l"],
  reply: ["r"],
  replyAll: ["shift+r", "a", "cmd+shift+r"],
  forward: ["f", "cmd+shift+f"],
  label: ["l"],
  move: ["v", "cmd+shift+m"],
  spam: ["!", "cmd+shift+j"],
  palette: ["cmd+k"],
  settings: ["cmd+,"],
  zoomIn: ["cmd+=", "cmd++"],
  zoomOut: ["cmd+-"],
  zoomReset: ["cmd+0"],
  undo: ["cmd+z"],
};

/** Send from the composer: ⌘↩ (Spark, most apps) or ⇧⌘D (Apple Mail). */
export const SEND = new Set(["cmd+Enter", "cmd+shift+d"]);

/** Keys per action after user overrides (an override replaces that action's whole list). */
export function keysFor(overrides: Record<string, string[]>): Record<string, string[]> {
  return Object.fromEntries(ACTIONS.map(([a]) => [a, overrides[a] ?? DEFAULT_KEYS[a] ?? []]));
}

/** combo → action lookup; a combo claimed by two actions resolves to the first in ACTIONS order. */
export function bindingsFrom(overrides: Record<string, string[]>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [action, combos] of Object.entries(keysFor(overrides))) {
    for (const c of combos) out[c] ??= action;
  }
  out.Escape = "escape";
  return out;
}

const SYMBOLS: Record<string, string> = {
  ArrowDown: "↓", ArrowUp: "↑", ArrowLeft: "←", ArrowRight: "→",
  Backspace: "⌫", Delete: "⌦", Enter: "↩", Escape: "Esc", " ": "Space", Tab: "⇥",
};

/** Mac-style label: "cmd+shift+r" → "⇧⌘R". */
export function formatCombo(combo: string) {
  const parts = combo === "+" ? ["+"] : combo.split(/\+(?!$)/);
  const key = parts.pop()!;
  const mods = new Set(parts);
  return (
    (mods.has("ctrl") ? "⌃" : "") + (mods.has("alt") ? "⌥" : "") + (mods.has("shift") ? "⇧" : "") + (mods.has("cmd") ? "⌘" : "") +
    (SYMBOLS[key] ?? key.toUpperCase())
  );
}

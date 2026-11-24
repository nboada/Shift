import { expect, test } from "bun:test";
import { SEND, bindingsFrom, comboOf, formatCombo } from "./keys";

const key = (key: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) =>
  comboOf({ key, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

test("default combos match the binding table", () => {
  const b = bindingsFrom({});
  expect(b[key("r")]).toBe("reply");
  expect(b[key("R", { shiftKey: true })]).toBe("replyAll");
  expect(b[key("r", { metaKey: true })]).toBe("sync");
  expect(b[key("z", { metaKey: true })]).toBe("undo");
  expect(b[key("R", { metaKey: true, shiftKey: true })]).toBe("replyAll");
  expect(b[key("#", { shiftKey: true })]).toBe("trash");
  expect(b[key("!", { shiftKey: true })]).toBe("spam");
  expect(b[key("a", { metaKey: true, ctrlKey: true })]).toBe("archive");
  expect(b[key("Backspace")]).toBe("trash");
  expect(b[key("n", { metaKey: true })]).toBe("compose");
  expect(b[key(",", { metaKey: true })]).toBe("settings");
  expect(b[key("k", { metaKey: true })]).toBe("palette");
  expect(b[key("+", { metaKey: true, shiftKey: true })]).toBe("zoomIn");
  expect(SEND.has(key("Enter", { metaKey: true }))).toBe(true);
  expect(SEND.has(key("d", { metaKey: true, shiftKey: true }))).toBe(true);
});

test("unbound modifier combos don't fall through to single-key actions", () => {
  const b = bindingsFrom({});
  expect(b[key("e", { metaKey: true })]).toBeUndefined();
  expect(b[key("Backspace", { metaKey: true })]).toBeUndefined();
});

test("overrides replace an action's keys", () => {
  const b = bindingsFrom({ archive: ["y"] });
  expect(b.y).toBe("archive");
  expect(b.e).toBeUndefined();
  expect(b.r).toBe("reply");
});

test("formats combos the Mac way", () => {
  expect(formatCombo("cmd+shift+r")).toBe("⇧⌘R");
  expect(formatCombo("ctrl+cmd+a")).toBe("⌃⌘A");
  expect(formatCombo("Backspace")).toBe("⌫");
  expect(formatCombo("cmd++")).toBe("⌘+");
  expect(formatCombo("#")).toBe("#");
});

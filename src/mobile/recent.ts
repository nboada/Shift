// Recent searches on the phone's search screen, newest first. Kept on this device only (localStorage): they're a
// convenience, and the Mac has no such list to share them with.
const KEY = "shift.recentSearches";
const MAX = 8;

/** The list with `query` added at the top: no repeats (ignoring case and spacing), at most eight. */
export function remember(list: string[], query: string) {
  const q = query.trim().replace(/\s+/g, " ");
  if (!q) return list;
  return [q, ...list.filter((x) => x.toLowerCase() !== q.toLowerCase())].slice(0, MAX);
}

export function loadRecent(): string[] {
  try {
    const list: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function saveRecent(list: string[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Private storage off or full: recent searches just aren't kept.
  }
}

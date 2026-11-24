/**
 * Command palette ranking: a label that contains the query beats one that only has its letters in order
 * ("arc" → "Archive" before "Mark read / unread"); earlier and word-start matches rank higher.
 * Returns -1 for no match.
 */
export function matchScore(label: string, query: string): number {
  const l = label.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const at = l.indexOf(q);
  if (at >= 0) return 1000 - at * 2 - (at > 0 && l[at - 1] !== " " ? 50 : 0);
  // Letters in order ("gti" → "Go to Inbox").
  let i = 0;
  let gaps = 0;
  for (const c of l) {
    if (c === q[i]) i++;
    else if (i > 0) gaps++;
    if (i === q.length) return 500 - gaps;
  }
  return -1;
}

export function rank<T extends { label: string }>(items: T[], query: string): T[] {
  return items
    .map((item, order) => ({ item, order, score: matchScore(item.label, query) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .map((x) => x.item);
}

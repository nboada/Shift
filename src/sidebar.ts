/** Leaves out hidden items and sorts the rest by `order`; items missing from it keep their place after the ordered ones. */
export function arrange<T>(items: T[], key: (x: T) => string, order: string[], hidden: string[]): T[] {
  const rank = (x: T) => (order.includes(key(x)) ? order.indexOf(key(x)) : order.length);
  return items.filter((x) => !hidden.includes(key(x))).sort((a, b) => rank(a) - rank(b));
}

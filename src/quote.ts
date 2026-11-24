// Quoted history in a reply (the email being answered, and the ones before it) is folded behind a "•••" button,
// as Gmail and Spark do, so a conversation shows each reply's own text.

// Gmail, Apple Mail, Thunderbird, Yahoo, and Outlook's "From: … Sent: …" header (the quote is it and what follows).
const QUOTE = ".gmail_quote, blockquote[type=cite], .moz-cite-prefix, .yahoo_quoted, #divRplyFwdMsg, #appendonsend";

/** Hides the quoted history and puts a toggle where it was. Returns false when there's none, or nothing above it. */
export function foldQuote(doc: Document): boolean {
  const first = doc.body.querySelector<HTMLElement>(QUOTE);
  if (!first) return false;
  // The top-level block that holds the quote, so everything after it is quoted too.
  let start: Element = first;
  while (start.parentElement && start.parentElement !== doc.body && !start.previousElementSibling) start = start.parentElement;
  const range = doc.createRange();
  range.setStart(doc.body, 0);
  range.setEndBefore(start);
  // A forward or an email that is all quote keeps it in view.
  if (!range.toString().trim() && !range.cloneContents().querySelector("img")) return false;
  const hidden: Element[] = [];
  for (let el: Element | null = start; el; el = el.nextElementSibling) hidden.push(el);
  // Outlook and Apple put the quote in a wrapper's last children; fold the wrapper's later siblings as well.
  for (let p = start.parentElement; p && p !== doc.body; p = p.parentElement) {
    for (let el = p.nextElementSibling; el; el = el.nextElementSibling) hidden.push(el);
  }
  hidden.forEach((el) => el.classList.add("shift-folded"));
  const button = doc.createElement("button");
  button.type = "button";
  button.className = "shift-fold";
  button.title = "Show quoted text";
  button.setAttribute("aria-expanded", "false");
  button.textContent = "•••";
  start.before(button);
  button.addEventListener("click", () => {
    const open = button.getAttribute("aria-expanded") !== "true";
    button.setAttribute("aria-expanded", String(open));
    button.title = open ? "Hide quoted text" : "Show quoted text";
    hidden.forEach((el) => el.classList.toggle("shift-folded", !open));
  });
  return true;
}

export const FOLD_CSS = `.shift-folded { display: none !important; }
.shift-fold { display: flex; align-items: center; justify-content: center; margin: 12px 0; padding: 0 0 2px 1px; width: 32px; height: 16px; border: 0; border-radius: 8px; background: #e8e8ed; color: #6e6e73; font: 600 10px/1 -apple-system, system-ui, sans-serif; letter-spacing: 1px; cursor: pointer; }
.shift-fold:hover { background: #dcdce1; color: #1d1d1f; }`;

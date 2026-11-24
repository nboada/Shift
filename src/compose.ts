import { Node } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Placeholder } from "@tiptap/extensions";
import StarterKit from "@tiptap/starter-kit";

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain text as editor paragraphs, one per line. */
export const textToHtml = (text: string) => text.split("\n").map((l) => `<p>${escapeHtml(l)}</p>`).join("");

/**
 * The HTML signature as one block in the editor. It holds no markup of its own: the editor shows a sandboxed preview
 * and `emailHtml` swaps the placeholder for the signature at save/send time, so its HTML never runs in the app.
 */
export const Signature = Node.create({
  name: "signature",
  group: "block",
  atom: true,
  selectable: true,
  parseHTML: () => [{ tag: "div[data-signature]" }],
  renderHTML: () => ["div", { "data-signature": "" }],
});

/** An element's text with a line break after each block (paragraph, row, list item…), which textContent drops. */
export function blockText(el: Element) {
  const copy = el.cloneNode(true) as Element;
  copy.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
  copy.querySelectorAll("td, th").forEach((c) => c.append(" "));
  copy.querySelectorAll("p, div, li, tr, h1, h2, h3, h4, h5, h6, blockquote, pre, table").forEach((b) => b.append("\n"));
  return (copy.textContent ?? "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * The email being replied to or forwarded, kept whole (images, tables, its own styles) instead of reduced to the
 * editor's formatting. One block, like the signature: the editor shows a sandboxed preview and `emailHtml` puts the
 * HTML back at save and send time. Reopened drafts bring it back from the top-level `blockquote.gmail_quote`.
 */
export const Quote = Node.create({
  name: "quote",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes: () => ({
    html: { default: "", parseHTML: (el) => el.getAttribute("data-quote") ?? el.innerHTML, renderHTML: (a) => ({ "data-quote": a.html }) },
    text: { default: "", parseHTML: (el) => el.getAttribute("data-text") ?? blockText(el), renderHTML: (a) => ({ "data-text": a.text }) },
  }),
  parseHTML: () => [{ tag: "div[data-quote]" }, { tag: "blockquote.gmail_quote", priority: 60 }],
  renderHTML: ({ HTMLAttributes }) => ["div", HTMLAttributes],
});

export const extensions = [
  StarterKit.configure({ heading: false, codeBlock: false, code: false, link: { openOnClick: false, autolink: true } }),
  // Not only the line with the cursor: the stylesheet shows it on the first line while that line is empty, signature below or not.
  Placeholder.configure({ placeholder: "Write your message…", showOnlyCurrent: false }),
  Signature,
  Quote,
];

/** Whether anything is written above the signature (an HTML one, or a text one's "-- " line) or the quote. */
export function hasMessage(doc: PMNode) {
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i);
    if (["signature", "blockquote", "quote"].includes(node.type.name) || node.textContent === "-- ") return false;
    // A reply's "On … wrote:" line, right before its quote.
    if (/wrote:\s*$/.test(node.textContent) && ["blockquote", "quote"].includes(doc.maybeChild(i + 1)?.type.name ?? "")) return false;
    if (node.textContent.trim() || node.type.name !== "paragraph") return true;
  }
  return false;
}

const QUOTE_STYLE = "margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex";

/** An attribute value as the editor's HTML serialises it, back to the HTML it holds. */
const unescapeAttr = (s: string) =>
  s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, "\u00a0").replace(/&#39;/g, "'").replace(/&amp;/g, "&");

/** Editor HTML as sent: email-safe paragraph spacing, Gmail's quote style, the quoted email whole, and the real HTML
 *  signature. Quotes are set aside first, so the rewrites never touch their markup. */
export function emailHtml(html: string, sigHtml: string) {
  const quotes: string[] = [];
  return html
    .replace(/<div data-quote="([^"]*)"(?: data-text="[^"]*")?><\/div>/g, (_, q: string) => `\u0000${quotes.push(unescapeAttr(q)) - 1}\u0000`)
    .replace(/<p><\/p>/g, "<p><br></p>")
    .replace(/<p>/g, '<p style="margin:0">')
    .replace(/<blockquote>/g, `<blockquote style="${QUOTE_STYLE}">`)
    .replace(/<div data-signature="[^"]*"><\/div>/g, () => `<div class="signature">${sigHtml}</div>`)
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => `<blockquote class="gmail_quote" style="${QUOTE_STYLE}">${quotes[Number(i)]}</blockquote>`);
}

/** Plain-text version of the editor document: "> " quotes, list markers, link URLs and the "-- " signature kept. */
export function docToText(doc: PMNode, sigText = ""): string {
  const inline = (n: PMNode) => {
    let s = "";
    let href: string | null = null;
    let linked = "";
    const endLink = () => {
      if (href && href !== linked && href !== `mailto:${linked}`) s += ` <${href}>`;
      href = null;
      linked = "";
    };
    n.forEach((c) => {
      const h = c.marks.find((m) => m.type.name === "link")?.attrs.href ?? null;
      if (h !== href) endLink();
      href = h;
      if (c.isText) {
        s += c.text;
        if (h) linked += c.text;
      } else if (c.type.name === "hardBreak") s += "\n";
    });
    endLink();
    return s;
  };
  const lines = (n: PMNode): string[] => {
    const kids = () => {
      const out: string[] = [];
      n.forEach((c) => out.push(...lines(c)));
      return out;
    };
    switch (n.type.name) {
      case "paragraph":
        return inline(n).split("\n");
      case "blockquote":
        return kids().map((l) => (l ? `> ${l}` : ">"));
      case "bulletList":
      case "orderedList": {
        const out: string[] = [];
        let i = n.attrs.start ?? 1;
        n.forEach((item) => {
          const mark = n.type.name === "bulletList" ? "- " : `${i++}. `;
          lines(item).forEach((l, j) => out.push((j ? " ".repeat(mark.length) : mark) + l));
        });
        return out;
      }
      case "signature":
        return ["-- ", ...sigText.trim().split("\n")];
      case "quote":
        return String(n.attrs.text).trimEnd().split("\n").map((l) => (l ? `> ${l}` : ">"));
      case "horizontalRule":
        return ["---"];
      default:
        return kids();
    }
  };
  return lines(doc).join("\n").trimEnd();
}

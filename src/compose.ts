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

export const extensions = [
  StarterKit.configure({ heading: false, codeBlock: false, code: false, link: { openOnClick: false, autolink: true } }),
  // Not only the line with the cursor: the stylesheet shows it on the first line while that line is empty, signature below or not.
  Placeholder.configure({ placeholder: "Write your message…", showOnlyCurrent: false }),
  Signature,
];

const QUOTE_STYLE = "margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex";

/** Editor HTML as sent: email-safe paragraph spacing, Gmail's quote style, and the real HTML signature. */
export const emailHtml = (html: string, sigHtml: string) =>
  html
    .replace(/<p><\/p>/g, "<p><br></p>")
    .replace(/<p>/g, '<p style="margin:0">')
    .replace(/<blockquote>/g, `<blockquote style="${QUOTE_STYLE}">`)
    .replace(/<div data-signature="[^"]*"><\/div>/g, () => `<div class="signature">${sigHtml}</div>`);

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
      case "horizontalRule":
        return ["---"];
      default:
        return kids();
    }
  };
  return lines(doc).join("\n").trimEnd();
}

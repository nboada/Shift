import { expect, test } from "bun:test";
import { getSchema } from "@tiptap/core";
import { Node } from "@tiptap/pm/model";
import { docToText, emailHtml, extensions, hasMessage, textToHtml } from "./compose";

const schema = getSchema(extensions);
const t = (text: string, marks?: unknown[]) => ({ type: "text", text, marks });
const p = (...content: unknown[]) => ({ type: "paragraph", content: content.length ? content : undefined });
const doc = (...content: unknown[]) => Node.fromJSON(schema, { type: "doc", content });

test("plain text becomes escaped paragraphs", () => {
  expect(textToHtml("a < b\nsecond")).toBe("<p>a &lt; b</p><p>second</p>");
});

test("text version keeps quotes, lists, links and the signature", () => {
  const link = { type: "link", attrs: { href: "https://shift.app" } };
  const d = doc(
    p(t("See "), t("the site", [link]), t(".")),
    { type: "bulletList", content: [{ type: "listItem", content: [p(t("one"))] }, { type: "listItem", content: [p(t("two"))] }] },
    { type: "orderedList", content: [{ type: "listItem", content: [p(t("first"))] }] },
    p(),
    { type: "signature" },
    p(t("On Mon, Maya wrote:")),
    { type: "blockquote", content: [p(t("Hello"), { type: "hardBreak" }, t("there")), p()] },
  );
  expect(docToText(d, "Nic\nShift")).toBe(
    "See the site <https://shift.app>.\n- one\n- two\n1. first\n\n-- \nNic\nShift\nOn Mon, Maya wrote:\n> Hello\n> there\n>",
  );
});

test("a link whose text is its URL isn't repeated", () => {
  const link = { type: "link", attrs: { href: "https://shift.app" } };
  expect(docToText(doc(p(t("https://shift.app", [link]))))).toBe("https://shift.app");
});

test("sent HTML: spaced paragraphs, styled quote, signature swapped in", () => {
  const html = emailHtml('<p>Hi</p><p></p><div data-signature=""></div><blockquote><p>q</p></blockquote>', "<b>Nic $&</b>");
  expect(html).toBe(
    '<p style="margin:0">Hi</p><p style="margin:0"><br></p><div class="signature"><b>Nic $&</b></div>' +
      '<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"><p style="margin:0">q</p></blockquote>',
  );
});

test("the placeholder goes once anything is written above the signature", () => {
  const sig = { type: "signature" };
  expect(hasMessage(doc(p(), p(), sig))).toBe(false);
  expect(hasMessage(doc(p(), p(t("hi")), sig))).toBe(true);
  expect(hasMessage(doc(p(), p(t("-- ")), p(t("Nic"))))).toBe(false);
  expect(hasMessage(doc(p(), { type: "blockquote", content: [p(t("old"))] }))).toBe(false);
  expect(hasMessage(doc(p(), p(t("On Monday, Sam wrote:")), { type: "blockquote", content: [p(t("old"))] }))).toBe(false);
});

test("a quoted email keeps its own HTML when sent, and quotes its text", () => {
  const html = '<table><tr><td><img src="https://x.com/a.png" alt="a &amp; b"></td></tr></table>';
  const d = doc(p(t("Sounds good")), p(t("On Mon, Maya wrote:")), { type: "quote", attrs: { html, text: "Hi\n\nSee you" } });
  expect(docToText(d)).toBe("Sounds good\nOn Mon, Maya wrote:\n> Hi\n>\n> See you");
  expect(hasMessage(d)).toBe(true);
  // As the editor serialises it: the HTML escaped inside the attribute.
  const attr = html.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const sent = emailHtml(`<p>Sounds good</p><div data-quote="${attr}" data-text="Hi"></div>`, "");
  expect(sent).toContain(`<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${html}</blockquote>`);
  expect(sent).toContain('<p style="margin:0">Sounds good</p>');
  // Serialisers that leave < and > unescaped in attributes: the quote's own <p> keeps no added style.
  const raw = emailHtml(`<div data-quote="<p>Hi &amp; bye</p>" data-text="Hi"></div>`, "");
  expect(raw).toBe('<blockquote class="gmail_quote" style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex"><p>Hi & bye</p></blockquote>');
});


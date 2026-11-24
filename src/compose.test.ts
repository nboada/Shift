import { expect, test } from "bun:test";
import { splitAtQuote, textToHtml, withHtmlSignature } from "./compose";

test("escapes text and keeps line breaks and quotes", () => {
  expect(textToHtml("a < b\nsecond")).toBe("a &lt; b<br>second");
  expect(textToHtml("hi\n> quoted\n> more")).toContain("<blockquote");
  expect(textToHtml("hi\n> quoted")).toContain("quoted</blockquote>");
});

test("signature goes between the reply and the quoted message", () => {
  const marker = "On Mon, Maya wrote:";
  const body = `Thanks!\n\n${marker}\n> Hello`;
  expect(splitAtQuote(body, marker)).toEqual(["Thanks!", `${marker}\n> Hello`]);
  const { text, html } = withHtmlSignature(body, marker, "<b>Nic</b>", "Nic");
  expect(text).toBe(`Thanks!\n\n-- \nNic\n\n${marker}\n> Hello`);
  expect(html.indexOf("<b>Nic</b>")).toBeLessThan(html.indexOf("On Mon, Maya wrote:"));
  expect(html).not.toContain("<script");
});

test("without a quote (or if the user deleted it) the signature goes last", () => {
  expect(splitAtQuote("Hello\n\n", null)).toEqual(["Hello", ""]);
  expect(splitAtQuote("Hello", "On Mon, Maya wrote:")).toEqual(["Hello", ""]);
  expect(withHtmlSignature("Hello", null, "<i>sig</i>", "sig").text).toBe("Hello\n\n-- \nsig");
});

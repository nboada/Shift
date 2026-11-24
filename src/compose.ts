const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Plain composer text as HTML: escaped, line breaks kept, quoted ("> ") lines as a blockquote. */
export function textToHtml(text: string) {
  const out: string[] = [];
  let quote: string[] = [];
  const flush = () => {
    if (quote.length) out.push(`<blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${quote.join("<br>")}</blockquote>`);
    quote = [];
  };
  for (const line of text.split("\n")) {
    if (line.startsWith(">")) quote.push(escapeHtml(line.replace(/^> ?/, "")));
    else {
      flush();
      out.push(escapeHtml(line));
    }
  }
  flush();
  return out.join("<br>").replace(/<br>(<blockquote)/g, "$1").replace(/(<\/blockquote>)<br>/g, "$1");
}

/** Splits the body where the quoted reply / forwarded message starts, so the signature can sit above it. */
export function splitAtQuote(body: string, marker: string | null): [string, string] {
  const i = marker ? body.lastIndexOf(marker) : -1;
  return i < 0 ? [body.trimEnd(), ""] : [body.slice(0, i).trimEnd(), body.slice(i)];
}

/** Text and HTML versions of an email with an HTML signature between what was written and the quote. */
export function withHtmlSignature(body: string, marker: string | null, sigHtml: string, sigText: string) {
  const [written, quote] = splitAtQuote(body, marker);
  const text = `${written}\n\n-- \n${sigText.trim()}${quote ? `\n\n${quote}` : ""}`;
  const html =
    `<div dir="ltr">${textToHtml(written)}<br><br><div class="signature">${sigHtml}</div>` +
    (quote ? `<br><div class="quote">${textToHtml(quote)}</div>` : "") +
    "</div>";
  return { text, html };
}

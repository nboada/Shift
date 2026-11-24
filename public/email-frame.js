// Runs inside each email frame. The frame is sandboxed without allow-same-origin, so the app can't reach into it and
// the email can't reach the app: this script evens out the text, folds quoted history, and tells the app (by
// postMessage) the frame's height, which link was clicked and which keys were pressed. The frame's CSP allows this
// one file and no other script.
(() => {
  const post = (msg) => parent.postMessage({ shift: true, ...msg }, "*");
  const doc = document;

  // Body text arrives at 11–16px depending on the sender's client; bring that band to 14px, leave headings and fine
  // print. Measured before changing anything, so em/% sizes are judged against the sender's original sizes.
  function evenTextSize() {
    const els = [...doc.body.querySelectorAll("*")];
    const sizes = els.map((el) => parseFloat(getComputedStyle(el).fontSize));
    els.forEach((el, i) => sizes[i] >= 12 && sizes[i] <= 17 && el.style.setProperty("font-size", "14px", "important"));
  }

  // Quoted history in a reply is folded behind a "•••" button, as Gmail and Spark do. Gmail, Apple Mail, Thunderbird,
  // Yahoo, and Outlook's "From: … Sent: …" header (the quote is it and what follows).
  const QUOTE = ".gmail_quote, blockquote[type=cite], .moz-cite-prefix, .yahoo_quoted, #divRplyFwdMsg, #appendonsend";
  function foldQuote() {
    const first = doc.body.querySelector(QUOTE);
    if (!first) return;
    // The top-level block that holds the quote, so everything after it is quoted too.
    let start = first;
    while (start.parentElement && start.parentElement !== doc.body && !start.previousElementSibling) start = start.parentElement;
    const range = doc.createRange();
    range.setStart(doc.body, 0);
    range.setEndBefore(start);
    // A forward or an email that is all quote keeps it in view.
    if (!range.toString().trim() && !range.cloneContents().querySelector("img")) return;
    const hidden = [];
    for (let el = start; el; el = el.nextElementSibling) hidden.push(el);
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
  }

  try {
    if (doc.currentScript?.dataset.even) evenTextSize();
    foldQuote();
  } catch {
    // Odd markup: show the email as it is.
  }

  // The <html> box is as tall as the content (scrollHeight never drops below the frame's own height), so the frame
  // also shrinks when the quote folds away. Hidden frames measure 0 and aren't reported.
  let last = 0;
  const fit = () => {
    const h = Math.ceil(Math.max(doc.documentElement.getBoundingClientRect().height, doc.body.scrollHeight));
    if (h && h !== last) post({ type: "height", height: (last = h) });
  };
  fit();
  new ResizeObserver(() => requestAnimationFrame(fit)).observe(doc.body);

  // Every link opens in the browser, never inside the frame: HTML links, image-map areas and SVG links alike.
  doc.addEventListener("click", (e) => {
    const a = e.target.closest?.("a, area");
    if (!a) return;
    e.preventDefault();
    const raw = a.getAttribute("href") ?? a.getAttributeNS("http://www.w3.org/1999/xlink", "href") ?? "";
    let url = "";
    try { url = new URL(raw, "about:blank").href; } catch {}
    if (/^(https?|mailto):/i.test(url)) post({ type: "link", url });
  });

  // Where a link goes, shown by the app while it's hovered (the text of a link can say anything).
  let hovered = null;
  doc.addEventListener("mouseover", (e) => {
    const a = e.target.closest?.("a[href], area[href]") ?? null;
    if (a === hovered) return;
    hovered = a;
    let url = "";
    try { url = a ? new URL(a.getAttribute("href"), "about:blank").href : ""; } catch {}
    post({ type: "hover", url: /^(https?|mailto):/i.test(url) ? url : "" });
  });
  doc.documentElement.addEventListener("mouseleave", () => {
    hovered = null;
    post({ type: "hover", url: "" });
  });

  // Keys pressed after clicking into the email land here; the app's shortcuts get a copy.
  doc.addEventListener("keydown", (e) => {
    const { key, code, metaKey, ctrlKey, altKey, shiftKey } = e;
    post({ type: "key", key, code, metaKey, ctrlKey, altKey, shiftKey });
  });

  // Inline (cid:) images, whose bytes the app fetches after the email shows.
  addEventListener("message", (e) => {
    if (e.source !== parent || e.data?.type !== "cid") return;
    for (const img of doc.querySelectorAll('img[src^="cid:" i]')) {
      if (decodeURIComponent(img.getAttribute("src").slice(4)) === e.data.cid) img.src = e.data.src;
    }
  });
})();

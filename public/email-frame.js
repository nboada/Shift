// Runs inside each email frame. The frame is sandboxed without allow-same-origin, so the app can't reach into it and
// the email can't reach the app: this script evens out the text, folds quoted history, and tells the app (by
// postMessage) the frame's height, which link was clicked and which keys were pressed. The frame's CSP allows this
// one file and no other script.
(() => {
  const post = (msg) => parent.postMessage({ shift: true, ...msg }, "*");
  const doc = document;

  // Body text arrives at 11–16px depending on the sender's client. The size the message itself is written in becomes
  // the reader's size (14px, or what Settings → Appearance says), and every other size moves by the same factor, so
  // fine print (a signature, a footer) stays smaller than the body instead of being raised to it. Headings over 20px
  // stay as sent. Measured before changing anything, so em/% sizes are judged against the sender's original sizes.
  //
  // The body's size is read from the first visible text above any quoted history (BODY_SAMPLE characters), not from
  // the whole email: a long quoted thread in another size, or a long disclaimer in 7.5pt, would otherwise outvote a
  // short new message and leave it larger or smaller than every other email.
  const BODY_SAMPLE = 400;
  function evenTextSize(target) {
    const els = [doc.body, ...doc.body.querySelectorAll("*")];
    const sizes = els.map((el) => parseFloat(getComputedStyle(el).fontSize));
    const sizeOf = new Map(els.map((el, i) => [el, sizes[i]]));
    const quote = doc.body.querySelector(QUOTE);
    const quoted = (node) =>
      !!quote && (quote.contains(node) || !!(quote.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING));
    const weigh = (sample, skipQuote) => {
      const weight = new Map();
      let total = 0;
      const walk = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      for (let t = walk.nextNode(); t && total < sample; t = walk.nextNode()) {
        const n = t.textContent.trim().length;
        const el = t.parentElement;
        const size = sizeOf.get(el);
        if (!n || !el || size < 9 || size > 20 || (skipQuote && quoted(t))) continue;
        // Preheaders and other hidden text never show.
        if (!el.getClientRects().length || getComputedStyle(el).visibility === "hidden") continue;
        weight.set(size, (weight.get(size) ?? 0) + n);
        total += n;
      }
      let base = 0;
      let most = 0;
      for (const [size, n] of weight) if (n > most) [base, most] = [size, n];
      return base;
    };
    // An email that is all quote (a bare forward) has no new text above it: sample the quote then.
    const base = weigh(BODY_SAMPLE, true) || weigh(BODY_SAMPLE, false);
    if (!base) return;
    const factor = Math.min(1.5, Math.max(0.75, target / base));
    els.forEach((el, i) => {
      const size = sizes[i];
      if (size >= 9 && size <= 20)
        el.style.setProperty("font-size", `${Math.round(size * factor * 2) / 2}px`, "important");
    });
  }

  // Quoted history in a reply is folded behind a "•••" button, as Gmail and Spark do. Gmail, Apple Mail, Thunderbird,
  // Yahoo, and Outlook's "From: … Sent: …" header (the quote is it and what follows).
  const QUOTE = ".gmail_quote, blockquote[type=cite], .moz-cite-prefix, .yahoo_quoted, #divRplyFwdMsg, #appendonsend";
  function foldQuote() {
    const first = doc.body.querySelector(QUOTE);
    if (!first) return;
    // The top-level block that holds the quote, so everything after it is quoted too.
    let start = first;
    while (start.parentElement && start.parentElement !== doc.body && !start.previousElementSibling)
      start = start.parentElement;
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

  // Phones: an email laid out wider than the frame (newsletters, fixed-width tables) is scaled down to fit, so it
  // never scrolls sideways. Measured with the zoom off each time, since images and rotation change the width.
  const fitting = !!doc.currentScript?.dataset.fit;
  const fitWidth = () => {
    // iOS enlarges text in wide layouts on its own, which fights the zoom and overlaps the lines.
    doc.documentElement.style.webkitTextSizeAdjust = "100%";
    doc.body.style.zoom = "";
    const wide = doc.documentElement.scrollWidth;
    const room = doc.documentElement.clientWidth;
    if (wide > room + 1) doc.body.style.zoom = String(room / wide);
  };

  try {
    // data-even is the size in px; "1" (any older value) means the default 14px.
    const even = Number(doc.currentScript?.dataset.even);
    if (even) evenTextSize(even > 1 ? even : 14);
    foldQuote();
  } catch {
    // Odd markup: show the email as it is.
  }
  if (fitting) {
    fitWidth();
    addEventListener("load", fitWidth);
    addEventListener("resize", fitWidth);
  }

  // The <html> box is as tall as the content (scrollHeight never drops below the frame's own height), so the frame
  // also shrinks when the quote folds away. Hidden frames measure 0 and aren't reported.
  let last = 0;
  const fit = () => {
    // A zoomed body's scrollHeight is its unzoomed height, so a fitted email goes by the <html> box alone.
    const box = doc.documentElement.getBoundingClientRect().height;
    const h = Math.ceil(fitting ? box : Math.max(box, doc.body.scrollHeight));
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
    try {
      url = new URL(raw, "about:blank").href;
    } catch {}
    if (/^(https?|mailto):/i.test(url)) post({ type: "link", url });
  });

  // Where a link goes, shown by the app while it's hovered (the text of a link can say anything).
  let hovered = null;
  doc.addEventListener("mouseover", (e) => {
    const a = e.target.closest?.("a[href], area[href]") ?? null;
    if (a === hovered) return;
    hovered = a;
    let url = "";
    try {
      url = a ? new URL(a.getAttribute("href"), "about:blank").href : "";
    } catch {}
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

  // No WebKit menu (Reload, Open Link) unless text is selected, so Copy and Look Up still work.
  doc.addEventListener("contextmenu", (e) => {
    if (doc.getSelection()?.isCollapsed !== false) e.preventDefault();
  });

  // Inline (cid:) images, whose bytes the app fetches after the email shows.
  addEventListener("message", (e) => {
    if (e.source !== parent || e.data?.type !== "cid") return;
    for (const img of doc.querySelectorAll('img[src^="cid:" i]')) {
      let ref = img.getAttribute("src").slice(4);
      try {
        ref = decodeURIComponent(ref);
      } catch {}
      if (ref.toLowerCase() === String(e.data.cid).toLowerCase()) img.src = e.data.src;
    }
  });
})();

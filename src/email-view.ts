// What the desktop reader and the phone's conversation screen share: the sanitised, sandboxed email frame, the message
// cards with their invite and attachment parts, avatars, label chips and the dates and names on list rows.
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import DOMPurify from "dompurify";
import { attachmentButton, fileIcon, listedAttachments } from "./attachments";
import type { Label, MailCore, Message, Thread } from "./core/mail";
import { inviteCard, isCalendarFile } from "./invite";
import { IS_IOS } from "./platform";
import { FOLD_CSS } from "./quote";
import { bareEmail, displayName } from "./recipients";
import { accountSettings, settings } from "./settings";
import { toast } from "./toast";

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export { bareEmail, displayName };

export function shortDate(ms: number) {
  const d = new Date(ms);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString([], { month: "short", day: "numeric" });
  return d.toLocaleDateString();
}

const hash = (text: string) => [...text].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);

/** List heading for a date: Today, Yesterday, This week (last 7 days), then the month. */
export function dateGroup(ms: number) {
  const day = new Date();
  day.setHours(0, 0, 0, 0);
  const d = new Date(ms);
  if (d >= day) return "Today";
  if (d.getTime() >= day.getTime() - 86_400_000) return "Yesterday";
  if (d.getTime() >= day.getTime() - 6 * 86_400_000) return "This week";
  return d.toLocaleDateString([], {
    month: "long",
    ...(d.getFullYear() === day.getFullYear() ? {} : { year: "numeric" }),
  });
}

// Pairs from Gmail's label palette (it rejects other colours); text colour is what Gmail draws the name in.
export const LABEL_COLORS: [name: string, background: string, text: string][] = [
  ["Red", "#fb4c2f", "#ffffff"],
  ["Orange", "#ffad47", "#ffffff"],
  ["Yellow", "#fad165", "#000000"],
  ["Green", "#16a766", "#ffffff"],
  ["Mint", "#43d692", "#ffffff"],
  ["Teal", "#2da2bb", "#ffffff"],
  ["Blue", "#4a86e8", "#ffffff"],
  ["Purple", "#a479e2", "#ffffff"],
  ["Pink", "#f691b3", "#ffffff"],
  ["Grey", "#999999", "#ffffff"],
];
export const isHex = (c: string | null): c is string => !!c && /^#[0-9a-f]{6}$/i.test(c);
// Gmail colours go through a generated stylesheet (no inline styles); only #rrggbb values get into it.
export function labelColorCss(colors: string[]) {
  const hexes = new Set([...colors, ...LABEL_COLORS.map((c) => c[1])].filter(isHex).map((c) => c.toLowerCase()));
  // Dots take the colour as is; list chips a faded tint of it with the name in the colour, mixed toward the text colour
  // so pale ones (yellow, mint) stay readable.
  document.getElementById("label-colors")!.textContent = [...hexes]
    .map(
      (h) => `.label-dot[data-color="${h.slice(1)}"] { background: ${h}; }
.row-label[data-color="${h.slice(1)}"] { background: color-mix(in srgb, ${h} 16%, transparent); color: color-mix(in srgb, ${h} 70%, var(--text)); }`,
    )
    .join("\n");
}
/** A label's Gmail colour, or a plain grey dot when it has none, as in Gmail (a made-up colour looked like a real one). */
export const labelDot = (_name: string, color: string | null) =>
  isHex(color)
    ? `<span class="label-dot" data-color="${color.slice(1).toLowerCase()}"></span>`
    : `<span class="label-dot none"></span>`;

const PERSONAL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "fastmail.com",
  "bigpond.com",
]);

// shortcut: approximates the registrable domain (handles com.au/co.uk style suffixes); swap in a public-suffix list if logos misfire.
function siteDomain(domain: string) {
  const parts = domain.split(".");
  const n =
    parts.length > 2 && parts.at(-1)!.length === 2 && /^(com|co|org|net|gov|edu|ac)$/.test(parts.at(-2)!) ? 3 : 2;
  return parts.slice(-n).join(".");
}

/** Company logo for work domains, coloured initials otherwise (and whenever the logo is missing). */
export function avatar(addr: string) {
  const email = bareEmail(addr);
  const name = displayName(addr) || email;
  const initials =
    name
      .split(/[\s.@_-]+/)
      .filter((w) => /\w/.test(w))
      .slice(0, 2)
      .map((w) => w[0])
      .join("")
      .toUpperCase() || "?";
  const color = hash(email) % 8;
  const domain = email.split("@")[1] ?? "";
  const site = domain && !PERSONAL_DOMAINS.has(domain) ? siteDomain(domain) : "";
  const known = site ? logos.get(site) : false;
  // Initials show until a logo has loaded once; after that the domain's logo is drawn straight away.
  const logo =
    known === false
      ? ""
      : `<img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(site)}&sz=64" alt="" data-site="${esc(site)}"${known ? "" : ' class="pending"'}>`;
  return `<span class="avatar c${color}${known ? " logo" : ""}">${esc(initials)}${logo}</span>`;
}

/** Which sites have a logo, remembered across launches so the list never waits on the favicon service to decide. */
const logos = new Map<string, boolean>(
  Object.entries(
    (() => {
      try {
        return JSON.parse(localStorage.getItem("avatar-logos") ?? "{}") as Record<string, boolean>;
      } catch {
        return {};
      }
    })(),
  ),
);
let logosSave = 0;
function rememberLogo(site: string, has: boolean) {
  if (logos.get(site) === has) return;
  logos.set(site, has);
  clearTimeout(logosSave);
  logosSave = window.setTimeout(() => {
    try {
      localStorage.setItem("avatar-logos", JSON.stringify(Object.fromEntries(logos)));
    } catch {
      // Storage full or blocked: the logos just get looked up again next launch.
    }
  }, 1000);
}

// Google answers unknown domains with a 16px globe, so anything that small falls back to initials.
document.addEventListener(
  "load",
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.site) return;
    const has = img.naturalWidth >= 32;
    rememberLogo(img.dataset.site, has);
    if (!has) return img.remove();
    img.classList.remove("pending");
    img.parentElement?.classList.add("logo");
  },
  true,
);
document.addEventListener(
  "error",
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement) || !img.dataset.site) return;
    rememberLogo(img.dataset.site, false);
    img.remove();
  },
  true,
);

/** The thread's own (user) labels as coloured chips. */
export function labelChips(t: Thread, own: Label[]) {
  const ids = t.labels.split(" ");
  return own
    .filter((l) => ids.includes(l.id))
    .map(
      (l) =>
        `<span class="row-label"${isHex(l.color) ? ` data-color="${l.color.slice(1).toLowerCase()}"` : ""}>${esc(l.name)}</span>`,
    );
}

// Gmail snippets arrive HTML-escaped.
export function decodeEntities(s: string) {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}

export const EMAIL_CSS = `<style>
  body { margin: 0; padding: 16px; font: 14px/1.5 -apple-system, system-ui, sans-serif; color: #1d1d1f; overflow-wrap: anywhere; }
  img { max-width: 100%; height: auto; }
  blockquote { margin-left: 0; padding-left: 12px; border-left: 3px solid #ddd; color: #555; }
  ${FOLD_CSS}
</style>`;
// !important so it beats the inline font-family most HTML emails set; code keeps its monospace.
const UNIFORM_FONT_CSS = `<style>body :not(pre, code, kbd, samp, pre *, code *) { font-family: -apple-system, system-ui, sans-serif !important; }</style>`;

/** Something in the email that would load from the network: shown as the "Load images" bar. */
const REMOTE = `[src^="http" i], [src^="//"], [srcset], [poster], [background], image[href], [style*="url(" i]`;

/**
 * Sanitises an email for the reader with DOMPurify: no scripts, event handlers, javascript: links, forms, embedded
 * frames, meta refresh or <base>. The frame's CSP and sandbox stay as a second layer, not the only one.
 * Returns the HTML and whether it has remote content (images, backgrounds) to hold back.
 */
export function cleanEmail(html: string): { html: string; remote: boolean } {
  const clean = DOMPurify.sanitize(html, {
    WHOLE_DOCUMENT: true,
    ADD_TAGS: ["style"],
    FORBID_TAGS: [
      "form",
      "input",
      "button",
      "textarea",
      "select",
      "meta",
      "base",
      "link",
      "iframe",
      "frame",
      "object",
      "embed",
    ],
  });
  const doc = new DOMParser().parseFromString(clean, "text/html");
  const remote =
    !!doc.querySelector(REMOTE) || [...doc.querySelectorAll("style")].some((s) => /url\(/i.test(s.textContent ?? ""));
  return { html: doc.documentElement.outerHTML, remote };
}

/** Shows an email. Returns true when it has remote images that are being held back. `fit` scales a wide email down
 *  to the frame's width (email-frame.js). */
export function mountEmail(
  frame: HTMLIFrameElement,
  html: string,
  images = settings.appearance.loadRemoteImages,
  fit = false,
): boolean {
  const clean = cleanEmail(html);
  const hidden = !images && clean.remote;
  // No allow-same-origin: the email gets an opaque origin of its own, so nothing in it can reach the app. Scripts are
  // allowed only for public/email-frame.js, which reports size, links and keys by postMessage (see the listener
  // below); the CSP comes before any email markup and names that one file. The frame also inherits the app's CSP from
  // index.html; this one only tightens it. With remote images off, network loads are blocked whatever the markup.
  const script = new URL("/email-frame.js", location.href).href;
  const csp = `default-src 'none'; script-src ${script}; style-src 'unsafe-inline'; form-action 'none'; ${
    images
      ? "img-src data: blob: https: http:; media-src https: http:; font-src data: https: http:"
      : "img-src data: blob:; font-src data:"
  }`;
  frame.setAttribute("sandbox", "allow-scripts");
  // Hidden until it reports its height, so the default 150px frame and the sender's raw fonts never show.
  frame.classList.add("loading");
  frame.srcdoc =
    `<meta http-equiv="Content-Security-Policy" content="${csp}"><script defer src="${script}"${
      settings.appearance.uniformEmailFont ? ' data-even="1"' : ""
    }${fit ? ' data-fit="1"' : ""}></script>` +
    EMAIL_CSS +
    clean.html +
    (settings.appearance.uniformEmailFont ? UNIFORM_FONT_CSS : "");
  // Shown even if the frame's script never reports (it failed on odd markup, or didn't load).
  frame.onload = () => setTimeout(() => frame.classList.remove("loading"), 300);
  return hidden;
}

// Messages from email frames (public/email-frame.js). Only a frame of ours is listened to, matched by its window.
window.addEventListener("message", (e) => {
  if (!e.data?.shift) return;
  const frame = [...document.querySelectorAll<HTMLIFrameElement>(".message iframe")].find(
    (f) => f.contentWindow === e.source,
  );
  if (!frame) return;
  const d = e.data as { type: string; height?: number; url?: string } & Partial<KeyboardEventInit>;
  if (d.type === "height" && typeof d.height === "number") {
    frame.style.height = `${d.height}px`;
    frame.classList.remove("loading");
  } else if (d.type === "hover" && typeof d.url === "string") {
    const status = document.getElementById("link-status")!;
    status.textContent = d.url.replace(/^mailto:/i, "");
    status.hidden = !d.url;
  } else if (d.type === "link" && typeof d.url === "string" && /^(https?|mailto):/i.test(d.url)) {
    openUrl(d.url);
  } else if (d.type === "key" && typeof d.key === "string") {
    const { key, code, metaKey, ctrlKey, altKey, shiftKey } = d;
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key, code, metaKey, ctrlKey, altKey, shiftKey, bubbles: true, cancelable: true }),
    );
  }
});

/** One line of the email's text for its collapsed header. */
function preview(m: Message) {
  const text = m.text ?? new DOMParser().parseFromString(m.html ?? "", "text/html").body.textContent ?? "";
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}

const ACCORDION = { duration: 320, easing: "cubic-bezier(0.32, 0.72, 0, 1)" };

/** Opens or closes one email, animating its height. Closing keeps the content visible (and clipped) until the
 *  animation ends, so it slides shut instead of vanishing; a click mid-animation reverses from where it is. */
/** Collapsed messages whose email hasn't been rendered yet; opening one renders it first (`toggleMessage`). */
const lazyMounts = new WeakMap<HTMLElement, () => Promise<void>>();

export function toggleMessage(header: HTMLElement) {
  const el = header.parentElement!;
  const pending = lazyMounts.get(el);
  if (pending) {
    lazyMounts.delete(el);
    void pending().then(() => toggleMessage(header));
    return;
  }
  const opening = el.classList.contains("collapsed") || el.classList.contains("closing");
  header.setAttribute("aria-expanded", String(opening));
  const from = el.getBoundingClientRect().height;
  el.getAnimations().forEach((a) => a.cancel());
  el.classList.remove("closing");
  el.classList.add("collapsed");
  const closed = el.getBoundingClientRect().height;
  if (opening) {
    el.classList.remove("collapsed");
  }
  const to = opening ? el.getBoundingClientRect().height : closed;
  if (settings.accessibility.reduceMotion || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!opening) {
    el.classList.remove("collapsed");
    el.classList.add("closing");
  }
  const run = el.animate([{ height: `${from}px` }, { height: `${to}px` }], ACCORDION);
  if (opening) {
    for (const child of el.querySelectorAll(":scope > :not(header)"))
      child.animate([{ opacity: 0 }, { opacity: 1 }], { ...ACCORDION, duration: 240 });
  }
  run.finished.then(
    () => {
      if (!el.classList.contains("closing")) return;
      el.classList.remove("closing");
      el.classList.add("collapsed");
    },
    () => {},
  );
}

// ---- Attachments in the reader

export function attachmentStrip(m: Message, account: string) {
  const files = listedAttachments(m.attachments, m.html).filter((a) => !(m.invite && isCalendarFile(a)));
  if (!files.length) return "";
  return `<div class="attachments message-files">${files
    .map((a) =>
      attachmentButton(fileIcon(a.mime, a.filename), a.filename || "attachment", a.size, {
        account,
        message: m.id,
        idx: a.idx,
        name: a.filename || "attachment",
        mime: a.mime,
      }),
    )
    .join("")}</div>`;
}

/** Swaps `cid:` image sources for the attachment's bytes once the email has loaded (email-frame.js does the swap). */
export function showInlineImages(frame: HTMLIFrameElement, m: Message, account: string) {
  const refs = new Set(
    [...(m.html ?? "").matchAll(/cid:([^"'\s)>]+)/gi)].map(([, ref]) => {
      try {
        return decodeURIComponent(ref).toLowerCase();
      } catch {
        return ref.toLowerCase();
      }
    }),
  );
  const inline = m.attachments.filter((a) => a.content_id && refs.has(a.content_id.toLowerCase()));
  if (!inline.length) return;
  frame.addEventListener(
    "load",
    () => {
      for (const a of inline) {
        invoke<string>("attachment_data", { account, message: m.id, idx: a.idx })
          .then((data) =>
            frame.contentWindow?.postMessage(
              { type: "cid", cid: a.content_id, src: `data:${a.mime};base64,${data}` },
              "*",
            ),
          )
          .catch(() => {});
      }
    },
    { once: true },
  );
}

export type ReplyKind = "reply" | "all" | "forward";

/**
 * Appends a conversation's emails to `container` as message cards: older ones collapsed (their email rendered when
 * first opened), the newest open, each with its invite card, attachments and Reply, Reply all and Forward. `fit`
 * scales wide emails down to the frame's width instead of letting them scroll sideways.
 */
export function renderMessages(container: HTMLElement, messages: Message[], account: string, fit = false) {
  for (const m of messages) {
    const el = document.createElement("section");
    el.className = "message";
    const name = displayName(m.sender);
    const i = messages.indexOf(m);
    // Accordion: older emails in a conversation start collapsed to one line; the header toggles each one.
    if (messages.length > 1 && m !== messages.at(-1)) el.classList.add("collapsed");
    const toggles = messages.length > 1;
    el.innerHTML = `<header ${toggles ? `role="button" tabindex="0" aria-expanded="${!el.classList.contains("collapsed")}"` : ""}>
        ${avatar(m.sender)}
        <div class="meta"><strong>${esc(name)}</strong><span class="to">To: ${esc(m.recipients)}${m.cc ? `, Cc: ${esc(m.cc)}` : ""}</span><span class="preview">${esc(preview(m))}</span></div>
        <time>${new Date(m.date).toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</time>${toggles ? '<i class="ti ti-chevron-down toggle-caret" aria-hidden="true"></i>' : ""}
      </header>${inviteCard(m.invite, i)}`;
    if (m.html) {
      const frame = document.createElement("iframe");
      frame.title = `Email from ${name}`;
      el.append(frame);
      container.append(el);
      const html = m.html;
      const mount = () => {
        if (mountEmail(frame, html, undefined, fit)) {
          frame.insertAdjacentHTML(
            "beforebegin",
            `<div class="images-bar"><i class="ti ti-photo-off"></i><span>Remote images are hidden to protect your privacy.</span><button type="button">Load images</button></div>`,
          );
          frame.previousElementSibling!.querySelector("button")!.addEventListener("click", (e) => {
            (e.currentTarget as Element).closest(".images-bar")!.remove();
            mountEmail(frame, html, true, fit);
            showInlineImages(frame, m, account);
          });
        }
        showInlineImages(frame, m, account);
        // Resolves once the frame has loaded (and sized itself), or after a moment if it never says so.
        return new Promise<void>((done) => {
          frame.addEventListener("load", () => done(), { once: true });
          setTimeout(done, 600);
        });
      };
      // A long conversation used to build a document for every message up front; collapsed ones wait until opened.
      if (el.classList.contains("collapsed")) lazyMounts.set(el, mount);
      else void mount();
    } else {
      const text = document.createElement("div");
      text.className = "text";
      text.textContent = m.text ?? "";
      el.append(text);
      container.append(el);
    }
    el.insertAdjacentHTML(
      "beforeend",
      attachmentStrip(m, account) +
        `<footer class="message-actions">
        <button class="icon" data-reply="reply" data-msg="${i}" data-tip="Reply" aria-label="Reply"><i class="ti ti-arrow-back-up"></i></button>
        <button class="icon" data-reply="all" data-msg="${i}" data-tip="Reply all" aria-label="Reply all"><i class="ti ti-arrow-back-up-double"></i></button>
        <button class="icon" data-reply="forward" data-msg="${i}" data-tip="Forward" aria-label="Forward"><i class="ti ti-arrow-forward-up"></i></button>
      </footer>`,
    );
  }
}

/** Clicks and keys inside a container of message cards: open and close, reply, answer an invite, open a file. */
export function wireReader(container: HTMLElement, mail: MailCore, reply: (kind: ReplyKind, m: Message) => void) {
  container.addEventListener("click", (e) => {
    const header = (e.target as Element).closest<HTMLElement>(".message > header[role=button]");
    if (header && !(e.target as Element).closest("a, button")) toggleMessage(header);
  });
  container.addEventListener("keydown", (e) => {
    const header = (e.target as Element).closest<HTMLElement>(".message > header[role=button]");
    if (!header || (e.key !== "Enter" && e.key !== " ")) return;
    e.preventDefault();
    e.stopPropagation();
    toggleMessage(header);
  });
  container.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-reply]");
    if (b) reply(b.dataset.reply as ReplyKind, mail.messages[Number(b.dataset.msg)]);
  });

  // Yes, Maybe or No on an invite: shown as chosen at once, put back if the answer couldn't be sent.
  container.addEventListener("click", async (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>("[data-rsvp]");
    if (!b || b.getAttribute("aria-pressed") === "true") return;
    const m = mail.messages[Number(b.dataset.msg)];
    const account = mail.threads.find((t) => t.id === mail.selected)?.account ?? mail.defaultAccount();
    const group = [...b.parentElement!.querySelectorAll<HTMLButtonElement>("[data-rsvp]")];
    const before = group.find((x) => x.getAttribute("aria-pressed") === "true");
    const press = (on: HTMLButtonElement | undefined) =>
      group.forEach((x) => x.setAttribute("aria-pressed", String(x === on)));
    press(b);
    group.forEach((x) => (x.disabled = true));
    try {
      await invoke("rsvp", {
        account,
        message: m.id,
        status: b.dataset.rsvp,
        fromName: accountSettings(account).name,
      });
      toast(`Sent “${b.textContent?.trim()}” to ${m.invite?.organizer.name || m.invite?.organizer.email}`, {
        kind: "success",
      });
    } catch (err) {
      press(before);
      toast(`Couldn't send your answer: ${err}`, { kind: "error" });
    } finally {
      group.forEach((x) => (x.disabled = false));
    }
  });

  container.addEventListener("click", async (e) => {
    const el = (e.target as Element).closest<HTMLElement>(".message-files .attachment");
    if (!el) return;
    const { account, message, idx, name, mime } = el.dataset;
    try {
      // iOS has no Downloads folder: hand the file to the share sheet, which previews it and offers Save to Files.
      if (IS_IOS) {
        const data = await invoke<string>("attachment_data", { account, message, idx: Number(idx) });
        const bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
        const file = new File([bytes], name ?? "attachment", { type: mime || "application/octet-stream" });
        // Closing the sheet rejects the promise; that's a cancel, not an error.
        await navigator.share({ files: [file] }).catch(() => {});
        return;
      }
      const path = await invoke<string>("open_attachment", { account, message, idx: Number(idx) });
      toast(`Saved to ${path.split("/").slice(-2).join("/")}`, { kind: "success" });
    } catch (err) {
      toast(String(err), { kind: "error" });
    }
  });
}

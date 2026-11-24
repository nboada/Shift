import { Editor, Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import { Menu } from "@tauri-apps/api/menu";
import { Quote, Signature, extensions, hasMessage } from "./compose";
import { renderSignaturePreview } from "./settings-ui";

/** Whether a reply's quoted message is folded behind its ••• button (true until the user opens it). */
const quoteFoldKey = new PluginKey<boolean>("quoteFold");

/** Folds the quoted message again, for a newly opened reply. */
export const foldReplyQuote = (editor: Editor) => editor.view.dispatch(editor.state.tr.setMeta(quoteFoldKey, true));

/** The reply's quote: the last top-level blockquote and the "On … wrote:" line before it, as [from, header, quote]. */
function findQuote(doc: PMNode): [number, PMNode, PMNode] | null {
  let found: [number, PMNode, PMNode] | null = null;
  let prev: [number, PMNode] | null = null;
  doc.forEach((node, offset) => {
    if (["blockquote", "quote"].includes(node.type.name) && prev && /wrote:\s*$/.test(prev[1].textContent)) found = [prev[0], prev[1], node];
    prev = [offset, node];
  });
  return found;
}

/**
 * Shows a reply's quoted history as a ••• button, as the reader does, and hides it until clicked. Display only: the
 * quote stays in the document, so it is still sent and saved with the draft.
 */
const QuoteFold = Extension.create({
  name: "quoteFold",
  addProseMirrorPlugins: () => [
    new Plugin<boolean>({
      key: quoteFoldKey,
      state: { init: () => true, apply: (tr, folded) => tr.getMeta(quoteFoldKey) ?? folded },
      props: {
        decorations(state) {
          const quote = findQuote(state.doc);
          if (!quote) return null;
          const [from, header, block] = quote;
          const folded = quoteFoldKey.getState(state)!;
          const toggle = Decoration.widget(from, (view) => {
            const b = document.createElement("button");
            b.type = "button";
            b.className = "quote-toggle";
            b.textContent = "•••";
            b.title = folded ? "Show quoted text" : "Hide quoted text";
            b.setAttribute("aria-expanded", String(!folded));
            b.contentEditable = "false";
            b.addEventListener("mousedown", (e) => e.preventDefault());
            b.addEventListener("click", () => view.dispatch(view.state.tr.setMeta(quoteFoldKey, !folded)));
            return b;
          }, { side: -1, key: folded ? "quote-folded" : "quote-open", ignoreSelection: true, stopEvent: () => true });
          const hidden = folded
            ? [Decoration.node(from, from + header.nodeSize, { class: "quote-folded" }),
              Decoration.node(from + header.nodeSize, from + header.nodeSize + block.nodeSize, { class: "quote-folded" })]
            : [];
          return DecorationSet.create(state.doc, [toggle, ...hidden]);
        },
      },
    }),
  ],
});

type Command = "bold" | "italic" | "underline" | "link" | "bulletList" | "orderedList" | "blockquote";

/** Tiptap editor for the composer body, with the floating format bar that shows over a selection. */
export function createEditor(
  element: HTMLElement, bar: HTMLElement, onChange: () => void, signatureHtml: () => string,
  renderQuote: (frame: HTMLIFrameElement, html: string) => void,
) {
  const linkInput = bar.querySelector<HTMLInputElement>("input")!;
  let linking = false;

  const editor: Editor = new Editor({
    element,
    extensions: [
      ...extensions.filter((e) => e !== Signature && e !== Quote),
      Quote.extend({
        addNodeView: () => ({ node }) => {
          const dom = document.createElement("div");
          dom.className = "compose-quote";
          const frame = document.createElement("iframe");
          frame.title = "Quoted email";
          dom.append(frame);
          renderQuote(frame, node.attrs.html);
          return { dom };
        },
      }),
      QuoteFold,
      Signature.extend({
        addNodeView: () => () => {
          const dom = document.createElement("div");
          dom.className = "compose-signature";
          const frame = document.createElement("iframe");
          frame.setAttribute("sandbox", "allow-same-origin");
          frame.title = "Signature";
          dom.append(frame);
          renderSignaturePreview(frame, signatureHtml());
          return { dom };
        },
      }),
      Extension.create({
        name: "composerKeys",
        priority: 1000,
        addKeyboardShortcuts: () => ({
          // ⌘↩ sends (the app's keydown handler); without this the hard-break extension would also insert a line.
          "Mod-Enter": () => true,
          "Mod-k": () => (openLink(), true),
        }),
      }),
    ],
    editorProps: { attributes: { class: "compose-editor", "aria-label": "Message", spellcheck: "true" } },
    onUpdate: () => {
      onChange();
      place();
    },
    onSelectionUpdate: ({ editor }) => {
      // Until something is written, a click on a blank line below the first starts typing on the first one.
      const { doc, selection } = editor.state;
      if (selection.empty && !hasMessage(doc) && selection.$from.depth === 1 && selection.$from.index(0) > 0 && !selection.$from.parent.textContent) {
        editor.commands.setTextSelection(1);
      }
      place();
    },
    // The placeholder plugin only redraws the lines that changed, so typing on line two left it showing on line one.
    onTransaction: ({ editor }) => editor.view.dom.classList.toggle("has-message", hasMessage(editor.state.doc)),
    onBlur: ({ event }) => {
      if (!bar.contains(event.relatedTarget as Node | null)) place();
    },
  });

  function place() {
    const { from, to, empty } = editor.state.selection;
    bar.hidden = !linking && (empty || !editor.isFocused);
    if (bar.hidden) return;
    for (const b of bar.querySelectorAll<HTMLElement>("[data-cmd]")) b.classList.toggle("on", editor.isActive(b.dataset.cmd!));
    const a = editor.view.coordsAtPos(from);
    const b = editor.view.coordsAtPos(to);
    const x = (a.left + b.right) / 2 - bar.offsetWidth / 2;
    const above = a.top - bar.offsetHeight - 8;
    bar.style.left = `${Math.max(8, Math.min(x, window.innerWidth - bar.offsetWidth - 8))}px`;
    bar.style.top = `${above > 8 ? above : b.bottom + 8}px`;
  }

  function openLink() {
    linking = true;
    bar.classList.add("linking");
    linkInput.value = editor.getAttributes("link").href ?? "";
    place();
    linkInput.focus();
    linkInput.select();
  }

  function closeLink(refocus: boolean) {
    linking = false;
    bar.classList.remove("linking");
    if (refocus) editor.commands.focus();
    place();
  }

  function applyLink() {
    const v = linkInput.value.trim();
    const href = !v || /^[a-z][\w+.-]*:/i.test(v) ? v : /^[^/\s]+@[^/\s]+$/.test(v) ? `mailto:${v}` : `https://${v}`;
    const chain = editor.chain().focus().extendMarkRange("link");
    if (!href) chain.unsetLink().run();
    else if (editor.state.selection.empty && !editor.isActive("link"))
      chain.insertContent({ type: "text", text: v, marks: [{ type: "link", attrs: { href } }] }).run();
    else chain.setLink({ href }).run();
    closeLink(false);
  }

  const run: Record<Command, () => void> = {
    bold: () => editor.chain().focus().toggleBold().run(),
    italic: () => editor.chain().focus().toggleItalic().run(),
    underline: () => editor.chain().focus().toggleUnderline().run(),
    link: openLink,
    bulletList: () => editor.chain().focus().toggleBulletList().run(),
    orderedList: () => editor.chain().focus().toggleOrderedList().run(),
    blockquote: () => editor.chain().focus().toggleBlockquote().run(),
  };
  // Keep the editor's selection while clicking the bar's buttons.
  bar.addEventListener("mousedown", (e) => {
    if (e.target !== linkInput) e.preventDefault();
  });
  bar.addEventListener("click", (e) => {
    const b = (e.target as Element).closest<HTMLElement>("[data-cmd]");
    if (b) run[b.dataset.cmd as Command]();
  });
  linkInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.metaKey) {
      e.preventDefault();
      applyLink();
    } else if (e.key === "Escape") {
      // Escape here only closes the link field, not the composer.
      e.preventDefault();
      e.stopPropagation();
      closeLink(true);
    }
  });
  linkInput.addEventListener("blur", () => linking && closeLink(false));

  // Native menu, so Cut/Copy/Paste behave like the system's (WebKit blocks scripted paste).
  element.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    const check = (cmd: Command, text: string, accelerator?: string) =>
      ({ text, accelerator, checked: editor.isActive(cmd), action: run[cmd] });
    const sep = { item: "Separator" } as const;
    Menu.new({
      items: [
        { item: "Cut" }, { item: "Copy" }, { item: "Paste" }, { item: "SelectAll" }, sep,
        check("bold", "Bold", "CmdOrCtrl+B"),
        check("italic", "Italic", "CmdOrCtrl+I"),
        check("underline", "Underline", "CmdOrCtrl+U"),
        { text: editor.isActive("link") ? "Edit Link…" : "Add Link…", accelerator: "CmdOrCtrl+K", action: openLink },
        sep,
        check("bulletList", "Bulleted List"),
        check("orderedList", "Numbered List"),
        check("blockquote", "Quote"),
        sep,
        { text: "Clear Formatting", action: () => editor.chain().focus().unsetAllMarks().clearNodes().run() },
      ],
    }).then((m) => m.popup());
  });

  return editor;
}

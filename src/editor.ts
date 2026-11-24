import { Editor, Extension } from "@tiptap/core";
import { Signature, extensions } from "./compose";
import { renderSignaturePreview } from "./settings-ui";

type Command = "bold" | "italic" | "underline" | "link" | "bulletList" | "orderedList" | "blockquote";

/** Tiptap editor for the composer body, with the floating format bar that shows over a selection. */
export function createEditor(element: HTMLElement, bar: HTMLElement, onChange: () => void) {
  const linkInput = bar.querySelector<HTMLInputElement>("input")!;
  let linking = false;

  const editor: Editor = new Editor({
    element,
    extensions: [
      ...extensions.filter((e) => e !== Signature),
      Signature.extend({
        addNodeView: () => () => {
          const dom = document.createElement("div");
          dom.className = "compose-signature";
          const frame = document.createElement("iframe");
          frame.setAttribute("sandbox", "allow-same-origin");
          frame.title = "Signature";
          dom.append(frame);
          renderSignaturePreview(frame);
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
    onSelectionUpdate: () => place(),
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

  return editor;
}

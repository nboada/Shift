// Recipient field: addresses become removable chips, with autocomplete from people you've emailed.

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const EMAIL = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

/** "Maya Chen <maya@x.com>" → ["Maya Chen", "maya@x.com"]; a bare address has no name. */
export function parseAddress(raw: string): [string, string] {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  return m ? [m[1].trim(), m[2].trim()] : ["", raw.trim()];
}

/** Splits pasted or prefilled lists on commas/semicolons/newlines outside quotes and angle brackets. */
export function splitList(list: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  let angled = false;
  for (const c of list) {
    if (c === '"') quoted = !quoted;
    if (c === "<") angled = true;
    if (c === ">") angled = false;
    if (/[,;\n]/.test(c) && !quoted && !angled) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export const isValidAddress = (raw: string) => EMAIL.test(parseAddress(raw)[1]);

export class Recipients {
  private chips: string[] = [];
  private input: HTMLInputElement;
  private list: HTMLElement | null = null;
  private suggestions: string[] = [];
  private index = -1;
  private timer = 0;
  private seq = 0;

  constructor(
    private el: HTMLElement,
    private suggest: (q: string) => Promise<string[]>,
    private onChange: () => void,
  ) {
    this.input = el.querySelector("input")!;
    el.addEventListener("click", (e) => {
      const remove = (e.target as Element).closest<HTMLElement>("[data-remove]");
      if (remove) {
        this.chips.splice(Number(remove.dataset.remove), 1);
        this.render();
        this.onChange();
      }
      this.input.focus();
    });
    this.input.addEventListener("input", () => {
      clearTimeout(this.timer);
      if (/[,;]/.test(this.input.value)) return this.commit();
      this.timer = window.setTimeout(() => this.lookup(), 80);
    });
    this.input.addEventListener("keydown", (e) => this.onKey(e));
    this.input.addEventListener("paste", (e) => {
      const text = e.clipboardData?.getData("text") ?? "";
      if (!/[,;\n]/.test(text)) return;
      e.preventDefault();
      this.add(splitList(text));
    });
    this.input.addEventListener("blur", () =>
      window.setTimeout(() => {
        this.closeList();
        this.commit();
      }, 150),
    );
  }

  /** Comma-separated header value, including anything still being typed. */
  get value() {
    return [...this.chips, ...(this.input.value.trim() ? [this.input.value.trim()] : [])].join(", ");
  }

  get count() {
    return this.chips.length + (this.input.value.trim() ? 1 : 0);
  }

  set(list: string) {
    this.chips = splitList(list);
    this.input.value = "";
    this.render();
  }

  focus() {
    this.input.focus();
  }

  private add(items: string[]) {
    for (const item of items) {
      const email = parseAddress(item)[1].toLowerCase();
      if (item && !this.chips.some((c) => parseAddress(c)[1].toLowerCase() === email)) this.chips.push(item);
    }
    this.input.value = "";
    this.closeList();
    this.render();
    this.onChange();
  }

  private commit() {
    const text = this.input.value.replace(/[,;]+$/, "").trim();
    if (text) this.add(splitList(text));
  }

  private onKey(e: KeyboardEvent) {
    const open = this.suggestions.length > 0;
    if (open && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      this.index = e.key === "ArrowDown" ? Math.min(this.index + 1, this.suggestions.length - 1) : Math.max(this.index - 1, 0);
      this.renderList();
    } else if ((e.key === "Enter" || e.key === "Tab") && open && this.index >= 0) {
      e.preventDefault();
      this.add([this.suggestions[this.index]]);
    } else if ((e.key === "Enter" || e.key === "Tab") && this.input.value.trim()) {
      e.preventDefault();
      this.commit();
    } else if (e.key === "Backspace" && !this.input.value && this.chips.length) {
      this.chips.pop();
      this.render();
      this.onChange();
    } else if (e.key === "Escape" && open) {
      // Close the suggestions only: preventDefault stops the dialog's own Escape-to-close.
      e.preventDefault();
      e.stopPropagation();
      this.closeList();
    }
  }

  private async lookup() {
    const q = this.input.value.trim();
    const seq = ++this.seq;
    if (!q) return this.closeList();
    const found = await this.suggest(q);
    if (seq !== this.seq) return;
    const have = new Set(this.chips.map((c) => parseAddress(c)[1].toLowerCase()));
    this.suggestions = found.filter((f) => !have.has(parseAddress(f)[1].toLowerCase()));
    this.index = this.suggestions.length ? 0 : -1;
    this.renderList();
  }

  private closeList() {
    this.suggestions = [];
    this.index = -1;
    this.list?.remove();
    this.list = null;
  }

  private render() {
    this.el.querySelectorAll(".rchip").forEach((c) => c.remove());
    this.input.insertAdjacentHTML(
      "beforebegin",
      this.chips
        .map((c, i) => {
          const [name, email] = parseAddress(c);
          const bad = !EMAIL.test(email);
          return `<span class="rchip${bad ? " invalid" : ""}" data-tip="${esc(bad ? `Not a valid address: ${email}` : email)}">${esc(name || email)}<button type="button" data-remove="${i}" aria-label="Remove ${esc(name || email)}"><i class="ti ti-x"></i></button></span>`;
        })
        .join(""),
    );
    this.input.placeholder = this.chips.length ? "" : this.input.dataset.placeholder ?? "";
  }

  private renderList() {
    if (!this.suggestions.length) return this.closeList();
    if (!this.list) {
      this.list = document.createElement("div");
      this.list.className = "suggest rcpt-suggest";
      this.list.setAttribute("role", "listbox");
      // pointerdown keeps focus in the field, so blur doesn't commit the half-typed text first.
      this.list.addEventListener("pointerdown", (e) => {
        const b = (e.target as Element).closest<HTMLElement>("[data-i]");
        if (!b) return;
        e.preventDefault();
        this.add([this.suggestions[Number(b.dataset.i)]]);
      });
      this.el.append(this.list);
    }
    this.list.innerHTML = this.suggestions
      .map((s, i) => {
        const [name, email] = parseAddress(s);
        return `<button type="button" role="option" data-i="${i}" aria-selected="${i === this.index}" class="${i === this.index ? "on" : ""}">
          <span class="rcpt-name">${esc(name || email)}</span>${name ? `<small>${esc(email)}</small>` : ""}</button>`;
      })
      .join("");
  }
}

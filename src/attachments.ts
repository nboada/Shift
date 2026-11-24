import { iconClass } from "./icons";

/** A file on a received message, as `db::messages` returns it. */
export type Attachment = { idx: number; filename: string; mime: string; size: number; content_id: string | null };
/** A file in the composer, sent as `Draft.attachments`. `data` is standard base64. */
export type OutFile = { name: string; mime: string; data: string; size: number };

/** Gmail's limit for a whole message. */
export const MAX_BYTES = 25 * 1024 * 1024;

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** Icon name for a file (mapped to Tabler by iconClass). */
export function fileIcon(mime: string, name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (mime === "application/pdf" || ext === "pdf") return "file-pdf";
  if (mime.startsWith("image/")) return "file-image";
  if (mime.startsWith("audio/")) return "file-audio";
  if (mime.startsWith("video/")) return "file-video";
  if (/zip|compressed|x-tar|gzip/.test(mime) || ["zip", "gz", "tgz", "rar", "7z"].includes(ext)) return "file-zip";
  if (["doc", "docx", "pages", "rtf"].includes(ext) || mime.includes("wordprocessing")) return "file-doc";
  if (["xls", "xlsx", "numbers"].includes(ext) || mime.includes("spreadsheet")) return "file-xls";
  if (["ppt", "pptx", "key"].includes(ext) || mime.includes("presentation")) return "file-ppt";
  if (ext === "csv" || mime === "text/csv") return "file-csv";
  if (mime.startsWith("text/")) return "file-text";
  return "file";
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Files to list under a message: everything except inline images its HTML already shows. */
export function listedAttachments(list: Attachment[], html: string | null): Attachment[] {
  return list.filter((a) => !(a.content_id && html?.includes(`cid:${a.content_id}`)));
}

/** Total size after adding `extra`, or an error when it would pass Gmail's limit. */
export function checkSize(files: OutFile[], extra: number): string | null {
  const total = files.reduce((n, f) => n + f.size, 0) + extra;
  return total > MAX_BYTES ? `Attachments can't go over ${formatSize(MAX_BYTES)} in total (Gmail's limit)` : null;
}

export function readFile(file: File): Promise<OutFile> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const url = String(r.result);
      resolve({ name: file.name, mime: file.type || "application/octet-stream", data: url.slice(url.indexOf(",") + 1), size: file.size });
    };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

/** One attachment chip: icon, name and size. `data` attributes say which file it is. */
export function attachmentButton(icon: string, name: string, size: number, data: Record<string, string | number>, removable = false) {
  const attrs = Object.entries(data).map(([k, v]) => `data-${k}="${esc(String(v))}"`).join(" ");
  // Composer chips only remove; files under a message open on click.
  const [open, close] = removable ? ["<span", "</span>"] : ['<button type="button"', "</button>"];
  return `<span class="attachment" ${attrs}>
    ${open} class="attachment-open" title="${esc(name)}"><i class="${iconClass(icon)}"></i>
      <span class="attachment-name">${esc(name)}</span><span class="attachment-size">${formatSize(size)}</span>${close}
    ${removable ? `<button type="button" class="attachment-remove" aria-label="Remove ${esc(name)}"><i class="ti ti-x"></i></button>` : ""}
  </span>`;
}

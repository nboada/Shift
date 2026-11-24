import { expect, test } from "bun:test";
import { MAX_BYTES, checkSize, fileIcon, formatSize, listedAttachments } from "./attachments";

test("icons follow the file type", () => {
  expect(fileIcon("application/pdf", "a.pdf")).toBe("file-pdf");
  expect(fileIcon("application/octet-stream", "Report.PDF")).toBe("file-pdf");
  expect(fileIcon("image/png", "x.png")).toBe("file-image");
  expect(fileIcon("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "q.xlsx")).toBe("file-xls");
  expect(fileIcon("application/octet-stream", "blob")).toBe("file");
});

test("sizes read like Finder", () => {
  expect(formatSize(500)).toBe("500 B");
  expect(formatSize(2048)).toBe("2 KB");
  expect(formatSize(5 * 1024 * 1024)).toBe("5.0 MB");
});

test("inline images shown in the HTML aren't listed again", () => {
  const files = [
    { idx: 0, filename: "logo.png", mime: "image/png", size: 1, content_id: "logo@x" },
    { idx: 1, filename: "a.pdf", mime: "application/pdf", size: 1, content_id: null },
    { idx: 2, filename: "b.png", mime: "image/png", size: 1, content_id: "unused@x" },
  ];
  expect(listedAttachments(files, '<img src="cid:logo@x">').map((a) => a.idx)).toEqual([1, 2]);
  expect(listedAttachments(files, null).length).toBe(3);
});

test("the total stays under Gmail's limit", () => {
  const big = { name: "a", mime: "x", data: "", size: MAX_BYTES - 10 };
  expect(checkSize([big], 10)).toBeNull();
  expect(checkSize([big], 11)).toContain("25.0 MB");
});

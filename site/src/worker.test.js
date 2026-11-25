import { expect, test } from "bun:test";
import worker from "./worker.js";

const env = {
  ASSETS: { fetch: () => new Response("page") },
  DOWNLOADS: { get: async () => ({ body: "x", size: 1, httpEtag: "e" }), head: async () => ({}) },
};
const get = (url) => worker.fetch(new Request(url), env);

test("pages on www and the old domain move to getshiftmail.com", async () => {
  for (const [from, to] of [
    ["https://www.getshiftmail.com/privacy?a=1", "https://getshiftmail.com/privacy?a=1"],
    ["https://shift.talkk.com.au/", "https://getshiftmail.com/"],
    ["https://shift.talkk.com.au/changelog", "https://getshiftmail.com/changelog"],
  ]) {
    const r = await get(from);
    expect([r.status, r.headers.get("location")]).toEqual([301, to]);
  }
});

test("the old domain keeps serving updates and the download to installed apps", async () => {
  for (const url of [
    "https://shift.talkk.com.au/updates/latest.json",
    "https://shift.talkk.com.au/updates/Shift-0.2.11.app.tar.gz",
    "https://shift.talkk.com.au/download",
    "https://getshiftmail.com/updates/latest.json",
  ]) {
    expect((await get(url)).status).toBe(200);
  }
});

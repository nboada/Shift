import { expect, test } from "bun:test";
import worker from "./worker.js";

const env = { ASSETS: { fetch: () => new Response("page") } };
const get = (url) => worker.fetch(new Request(url), env);
const target = async (url) => {
  const r = await get(url);
  return [r.status, r.headers.get("location")];
};
const RELEASES = "https://github.com/nboada/Shift/releases";

test("pages on www and the old domain move to getshiftmail.com", async () => {
  expect(await target("https://www.getshiftmail.com/privacy?a=1")).toEqual([301, "https://getshiftmail.com/privacy?a=1"]);
  expect(await target("https://shift.talkk.com.au/")).toEqual([301, "https://getshiftmail.com/"]);
  expect(await target("https://shift.talkk.com.au/changelog")).toEqual([301, "https://getshiftmail.com/changelog"]);
});

test("the download and update feed point at GitHub releases on every domain", async () => {
  for (const host of ["getshiftmail.com", "shift.talkk.com.au"]) {
    expect(await target(`https://${host}/download`)).toEqual([302, `${RELEASES}/latest/download/Shift.dmg`]);
    expect(await target(`https://${host}/updates/latest.json`)).toEqual([302, `${RELEASES}/latest/download/latest.json`]);
    expect(await target(`https://${host}/updates/Shift-0.2.12.app.tar.gz`)).toEqual([
      302,
      `${RELEASES}/download/v0.2.12/Shift-0.2.12.app.tar.gz`,
    ]);
  }
});

test("pages on getshiftmail.com are served as they are", async () => {
  expect((await get("https://getshiftmail.com/")).status).toBe(200);
});

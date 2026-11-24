import { expect, test } from "bun:test";
import { DEFAULTS, signatureFor } from "./settings";

test("signatureFor uses the account's own signature, else the default", () => {
  const s = structuredClone(DEFAULTS);
  s.composer = { ...s.composer, signatureMode: "html", signature: "Nic", signatureHtml: "<b>Nic</b>" };
  const own = { mode: "text" as const, text: "Work Nic", html: "" };
  s.accounts = { "work@x.com": { color: "red", signature: own }, "home@x.com": { color: "blue" } };
  expect(signatureFor("work@x.com", s)).toEqual(own);
  expect(signatureFor("home@x.com", s)).toEqual({ mode: "html", text: "Nic", html: "<b>Nic</b>" });
  expect(signatureFor("unknown@x.com", s).html).toBe("<b>Nic</b>");
  expect(signatureFor(undefined, s).text).toBe("Nic");
});

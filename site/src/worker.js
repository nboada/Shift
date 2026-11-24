// Early access: saves the email, then the page shows the download, which streams from R2.
// It also serves the app update feed from R2. Everything else is a static file, served before this Worker runs.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const FILE = "Shift.dmg";

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);

    if (pathname === "/api/early-access" && request.method === "POST") {
      // A few sign-ups a minute per visitor is plenty; scripts flooding KV with junk addresses get turned away.
      const { success } = await env.SIGNUP_LIMIT.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
      if (!success) return json({ error: "Too many tries. Wait a minute and try again." }, 429);
      if (Number(request.headers.get("content-length") ?? 0) > 2048) return json({ error: "Request too large." }, 413);
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: "Send the email as JSON." }, 400);
      }
      if (!body || typeof body !== "object") return json({ error: "Send the email as JSON." }, 400);
      // A hidden field people never see; bots fill it in.
      if (body.website) return json({ download: null });
      const email = String(body.email ?? "").trim().toLowerCase();
      if (email.length > 254 || !EMAIL.test(email)) {
        return json({ error: "Enter a valid email address." }, 400);
      }
      const known = await env.EARLY_ACCESS.get(email);
      if (!known) {
        await env.EARLY_ACCESS.put(email, JSON.stringify({ at: new Date().toISOString() }));
      }
      // Until a build is uploaded, sign-ups are told they'll hear from us instead of getting a dead link.
      const ready = await env.DOWNLOADS.head(FILE);
      return json({ download: ready ? "/download" : null });
    }

    if (pathname === "/download" && (request.method === "GET" || request.method === "HEAD")) {
      const file = await env.DOWNLOADS.get(FILE);
      if (!file) return new Response("The download isn't available yet.", { status: 404 });
      return new Response(request.method === "HEAD" ? null : file.body, {
        headers: {
          "content-type": "application/x-apple-diskimage",
          "content-disposition": `attachment; filename="${FILE}"`,
          "content-length": String(file.size),
          etag: file.httpEtag,
        },
      });
    }

    // The app's update feed lives in R2 (uploaded by scripts/release.sh), so deploys from git don't need the files.
    const update = pathname.match(/^\/updates\/([\w.-]+)$/);
    if (update && (request.method === "GET" || request.method === "HEAD")) {
      const file = await env.DOWNLOADS.get(`updates/${update[1]}`);
      if (!file) return new Response("Not found", { status: 404 });
      return new Response(request.method === "HEAD" ? null : file.body, {
        headers: {
          "content-type": update[1].endsWith(".json") ? "application/json" : "application/gzip",
          "content-length": String(file.size),
          // Installed apps poll latest.json, so it must never be cached stale; bundles are versioned by name.
          "cache-control": update[1].endsWith(".json") ? "no-cache" : "public, max-age=31536000, immutable",
          etag: file.httpEtag,
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};

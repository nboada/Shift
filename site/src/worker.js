// The download and the app's update feed come from GitHub releases (published by scripts/release.sh); this Worker
// points getshiftmail.com/download and /updates/* at them, and moves pages off the old domain. Everything else is a
// static file.
const HOST = "getshiftmail.com";
const OLD_HOST = "shift.talkk.com.au";
const RELEASES = "https://github.com/nboada/Shift/releases";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/download") return Response.redirect(`${RELEASES}/latest/download/Shift.dmg`, 302);

    // Installed copies check /updates/latest.json every six hours; earlier versions ask the old domain for it.
    if (pathname === "/updates/latest.json") return Response.redirect(`${RELEASES}/latest/download/latest.json`, 302);
    const bundle = pathname.match(/^\/updates\/Shift-(\d+\.\d+\.\d+)\.app\.tar\.gz$/);
    if (bundle) return Response.redirect(`${RELEASES}/download/v${bundle[1]}/Shift-${bundle[1]}.app.tar.gz`, 302);

    if (url.hostname === `www.${HOST}` || url.hostname === OLD_HOST) {
      return Response.redirect(`https://${HOST}${pathname}${url.search}`, 301);
    }
    return env.ASSETS.fetch(request);
  },
};

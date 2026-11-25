#!/bin/sh
# Builds a Shift release for Apple silicon and Intel, signed with the Developer ID and notarized by Apple. It stages
# the update bundle and latest.json (which installed copies check every six hours) in site/.release/updates, and the
# .dmg in site/.release. Bump "version" in src-tauri/tauri.conf.json first, then:
#   scripts/release.sh "What changed, in a line"             build and stage only
#   scripts/release.sh --publish "What changed, in a line"   also put the .dmg in R2 (live at /download at once)
#                                                            and deploy the site (live update feed)
#
# One-time setup on the release Mac:
#   security add-generic-password -s shift-notary -a apple-id -w '<Apple ID email>'
#   security add-generic-password -s shift-notary -a app-password -w '<app-specific password>'
#   security add-generic-password -s shift-updater -a key -w "$(cat ~/.tauri/shift-updater.key)"
#   The update signing key (made with bunx tauri signer generate) lives in the Keychain, not a plain file: anyone who
#   reads it can sign updates that installed copies install. Once it's in the Keychain, move ~/.tauri/shift-updater.key
#   to an offline backup; losing the key means installed copies can't verify future updates.
set -eu
cd "$(dirname "$0")/.."

# A release ships exactly what's committed, after the same checks as any change.
if [ -n "$(git status --porcelain)" ]; then
  echo "error: commit or stash your changes first; a release builds only what's committed" >&2
  exit 1
fi
bun install --frozen-lockfile
# The site's own packages (Astro, wrangler): the final deploy builds the site, and a fresh checkout has none.
(cd site && bun install --frozen-lockfile)
bun test
bun run build
(cd src-tauri && cargo fmt --check && cargo test && cargo clippy --all-targets -- -D warnings)

PUBLISH=0
if [ "${1:-}" = "--publish" ]; then PUBLISH=1; shift; fi
VERSION=$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
NOTES=${1:-"Shift $VERSION"}
TEAM=65AK786Q34
IDENTITY="Developer ID Application: Nicolas Boada Morales ($TEAM)"

# Tauri notarizes and staples the .app itself when these are set.
APPLE_ID=$(security find-generic-password -s shift-notary -a apple-id -w)
APPLE_PASSWORD=$(security find-generic-password -s shift-notary -a app-password -w)
if ! TAURI_SIGNING_PRIVATE_KEY=$(security find-generic-password -s shift-updater -a key -w 2>/dev/null); then
  echo "warning: the update signing key isn't in the Keychain yet; reading ~/.tauri/shift-updater.key (see the header)" >&2
  TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/shift-updater.key)
fi
export APPLE_ID APPLE_PASSWORD TAURI_SIGNING_PRIVATE_KEY
export APPLE_TEAM_ID=$TEAM TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

bun run tauri build --target universal-apple-darwin

OUT=src-tauri/target/universal-apple-darwin/release/bundle
DMG=$(ls "$OUT"/dmg/*.dmg)
TARBALL=$(ls "$OUT"/macos/*.app.tar.gz)
# A stripped binary can come out with a string table dyld refuses (see strip in Cargo.toml); that app wouldn't
# open, and an update to it couldn't be undone by another update.
if ! dyld_info -platform "$OUT"/macos/*.app/Contents/MacOS/* >/dev/null; then
  echo "error: dyld won't load the built binary; don't ship it" >&2
  exit 1
fi

# The .app inside is already notarized; the disk image gets its own ticket so it opens cleanly offline too.
codesign --force --sign "$IDENTITY" "$DMG"
xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$TEAM" --wait
xcrun stapler staple "$DMG"

# Staged outside site/public on purpose: anything there is deployed with the site, and Cloudflare serves static files
# before the Worker, so a staged-but-unpublished build would go live on the next site deploy.
# The old staging folder, if this checkout still has one: left there it would be deployed and shadow the R2 feed.
rm -rf site/public/updates
mkdir -p site/.release/updates
cp "$DMG" site/.release/Shift.dmg
cp "$TARBALL" "site/.release/updates/Shift-$VERSION.app.tar.gz"


VERSION="$VERSION" NOTES="$NOTES" SIG="$(cat "$TARBALL.sig")" python3 - <<'EOF'
import json, os, datetime
v = os.environ["VERSION"]
entry = {"signature": os.environ["SIG"], "url": f"https://shift.talkk.com.au/updates/Shift-{v}.app.tar.gz"}
feed = {
    "version": v,
    "notes": os.environ["NOTES"],
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    # One universal build serves both architectures.
    "platforms": {"darwin-aarch64": entry, "darwin-x86_64": entry},
}
json.dump(feed, open("site/.release/updates/latest.json", "w"), indent=2)
EOF

if [ "$PUBLISH" = 1 ]; then
  # The Worker serves /updates/* from R2, so the feed works however the site itself is deployed.
  (cd site && bunx wrangler r2 object put shift-downloads/Shift.dmg --file .release/Shift.dmg --remote \
    --content-type application/x-apple-diskimage \
    && bunx wrangler r2 object put "shift-downloads/updates/Shift-$VERSION.app.tar.gz" --file ".release/updates/Shift-$VERSION.app.tar.gz" --remote \
    && bunx wrangler r2 object put shift-downloads/updates/latest.json --file .release/updates/latest.json --remote \
      --content-type application/json \
    && bunx wrangler deploy)
  git tag -a "v$VERSION" -m "Shift $VERSION" && git push -q origin "v$VERSION"
  echo "Published Shift $VERSION (tagged v$VERSION)."
else
  echo "Staged Shift $VERSION. Publish with: scripts/release.sh --publish, or by hand:"
  echo "  cd site && bunx wrangler r2 object put shift-downloads/Shift.dmg --file .release/Shift.dmg --remote && bunx wrangler deploy"
fi

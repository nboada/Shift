#!/bin/sh
# Builds a Shift release for Apple silicon and Intel, signed with the Developer ID and notarized by Apple. It stages
# the update bundle and latest.json (which installed copies check every six hours) in site/public/updates, and the
# .dmg in site/.release. Bump "version" in src-tauri/tauri.conf.json first, then:
#   scripts/release.sh "What changed, in a line"             build and stage only
#   scripts/release.sh --publish "What changed, in a line"   also put the .dmg in R2 (live at /download at once)
#                                                            and deploy the site (live update feed)
#
# One-time setup on the release Mac:
#   security add-generic-password -s shift-notary -a apple-id -w '<Apple ID email>'
#   security add-generic-password -s shift-notary -a app-password -w '<app-specific password>'
#   ~/.tauri/shift-updater.key, the update signing key (bunx tauri signer generate). Back it up: losing it means
#   installed copies can't verify future updates; leaking it lets someone sign updates as Shift.
set -eu
cd "$(dirname "$0")/.."

PUBLISH=0
if [ "${1:-}" = "--publish" ]; then PUBLISH=1; shift; fi
VERSION=$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
NOTES=${1:-"Shift $VERSION"}
TEAM=65AK786Q34
IDENTITY="Developer ID Application: Nicolas Boada Morales ($TEAM)"

# Tauri notarizes and staples the .app itself when these are set.
APPLE_ID=$(security find-generic-password -s shift-notary -a apple-id -w)
APPLE_PASSWORD=$(security find-generic-password -s shift-notary -a app-password -w)
TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/shift-updater.key)
export APPLE_ID APPLE_PASSWORD TAURI_SIGNING_PRIVATE_KEY
export APPLE_TEAM_ID=$TEAM TAURI_SIGNING_PRIVATE_KEY_PASSWORD=""

bun run tauri build --target universal-apple-darwin

OUT=src-tauri/target/universal-apple-darwin/release/bundle
DMG=$(ls "$OUT"/dmg/*.dmg)
TARBALL=$(ls "$OUT"/macos/*.app.tar.gz)

# The .app inside is already notarized; the disk image gets its own ticket so it opens cleanly offline too.
codesign --force --sign "$IDENTITY" "$DMG"
xcrun notarytool submit "$DMG" --apple-id "$APPLE_ID" --password "$APPLE_PASSWORD" --team-id "$TEAM" --wait
xcrun stapler staple "$DMG"

mkdir -p site/.release site/public/updates
cp "$DMG" site/.release/Shift.dmg
cp "$TARBALL" "site/public/updates/Shift-$VERSION.app.tar.gz"

# The update bundle is a static asset, and Cloudflare serves those up to 25 MiB. (The .dmg goes to R2, no limit.)
size=$(wc -c < "site/public/updates/Shift-$VERSION.app.tar.gz" | tr -d ' ')
[ "$size" -le 26214400 ] || { echo "error: the update bundle is $size bytes, over Cloudflare's 25 MiB limit" >&2; exit 1; }

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
json.dump(feed, open("site/public/updates/latest.json", "w"), indent=2)
EOF

if [ "$PUBLISH" = 1 ]; then
  # The Worker serves /updates/* from R2, so the feed works however the site itself is deployed.
  (cd site && bunx wrangler r2 object put shift-downloads/Shift.dmg --file .release/Shift.dmg --remote \
    --content-type application/x-apple-diskimage \
    && bunx wrangler r2 object put "shift-downloads/updates/Shift-$VERSION.app.tar.gz" --file "public/updates/Shift-$VERSION.app.tar.gz" --remote \
    && bunx wrangler r2 object put shift-downloads/updates/latest.json --file public/updates/latest.json --remote \
      --content-type application/json \
    && bunx wrangler deploy)
  echo "Published Shift $VERSION."
else
  echo "Staged Shift $VERSION. Publish with: scripts/release.sh --publish, or by hand:"
  echo "  cd site && bunx wrangler r2 object put shift-downloads/Shift.dmg --file .release/Shift.dmg --remote && bunx wrangler deploy"
fi

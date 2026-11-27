#!/bin/sh
# Builds a Shift release for Apple silicon and Intel, signed with the Developer ID and notarized by Apple. It stages
# Shift.dmg, the update bundle and latest.json (which installed copies check every six hours) in .release. Bump
# "version" in src-tauri/tauri.conf.json, commit and push, then:
#   scripts/release.sh "What changed, in a line"             build and stage only
#   scripts/release.sh --publish "What changed, in a line"   also publish them as GitHub release v<version>, which
#                                                            getshiftmail.com/download and /updates point at
# Needs `gh` signed in with access to the repository.
#
# One-time setup on the release Mac:
#   The App Store Connect API key (team key "Shift releases", App Manager), base64 so it fits on one line. Keep the
#   .p8 offline (or in ~/.appstoreconnect/private_keys, mode 600); notarization reads only the Keychain copy:
#   printf 'add-generic-password -U -s shift-asc-api -a <key id> -w %s\n' "$(base64 -i AuthKey_<key id>.p8)" | security -i
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
bun run format:check
(cd src-tauri && cargo fmt --check && cargo test && cargo clippy --all-targets -- -D warnings)

PUBLISH=0
if [ "${1:-}" = "--publish" ]; then PUBLISH=1; shift; fi
VERSION=$(python3 -c 'import json; print(json.load(open("src-tauri/tauri.conf.json"))["version"])')
NOTES=${1:-"Shift $VERSION"}
TEAM=65AK786Q34
IDENTITY="Developer ID Application: Nicolas Boada Morales ($TEAM)"

# Tauri notarizes and staples the .app itself when these are set. Notarization uses the API key, so no password is
# ever on a command line; the key is written to a private temp file for the build and removed after.
APPLE_API_KEY=48ZXPM47P5
APPLE_API_ISSUER=e93b6d82-6953-48c7-b0e0-e62e78812854
KEY_DIR=$(mktemp -d)
trap 'rm -rf "$KEY_DIR"' EXIT
APPLE_API_KEY_PATH=$KEY_DIR/AuthKey_$APPLE_API_KEY.p8
(umask 077 && security find-generic-password -s shift-asc-api -a "$APPLE_API_KEY" -w | base64 -d >"$APPLE_API_KEY_PATH")
if ! TAURI_SIGNING_PRIVATE_KEY=$(security find-generic-password -s shift-updater -a key -w 2>/dev/null); then
  echo "warning: the update signing key isn't in the Keychain yet; reading ~/.tauri/shift-updater.key (see the header)" >&2
  TAURI_SIGNING_PRIVATE_KEY=$(cat ~/.tauri/shift-updater.key)
fi
export APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH TAURI_SIGNING_PRIVATE_KEY
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
xcrun notarytool submit "$DMG" --key "$APPLE_API_KEY_PATH" --key-id "$APPLE_API_KEY" --issuer "$APPLE_API_ISSUER" --wait
xcrun stapler staple "$DMG"

REPO=nboada/Shift
STAGE=.release
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp "$DMG" "$STAGE/Shift.dmg"
cp "$TARBALL" "$STAGE/Shift-$VERSION.app.tar.gz"

REPO="$REPO" VERSION="$VERSION" NOTES="$NOTES" SIG="$(cat "$TARBALL.sig")" python3 - <<'EOF'
import json, os, datetime
v = os.environ["VERSION"]
url = f"https://github.com/{os.environ['REPO']}/releases/download/v{v}/Shift-{v}.app.tar.gz"
entry = {"signature": os.environ["SIG"], "url": url}
# The update dialog lists what's new: the site's changelog entry for this version when there is one.
notes = os.environ["NOTES"]
changelog = f"site/src/content/changelog/{v}.md"
if os.path.exists(changelog):
    body = open(changelog).read().split("---", 2)[-1].strip()
    notes = body or notes
feed = {
    "version": v,
    "notes": notes,
    "pub_date": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    # One universal build serves both architectures.
    "platforms": {"darwin-aarch64": entry, "darwin-x86_64": entry},
}
json.dump(feed, open(".release/latest.json", "w"), indent=2)
EOF

if [ "$PUBLISH" = 1 ]; then
  # The release's tag is made on GitHub at this commit, so it has to be there already.
  if [ "$(git rev-parse HEAD)" != "$(git rev-parse '@{upstream}' 2>/dev/null)" ]; then
    echo "error: push this commit first; the release is tagged on GitHub at it" >&2
    exit 1
  fi
  gh release create "v$VERSION" "$STAGE/Shift.dmg" "$STAGE/Shift-$VERSION.app.tar.gz" "$STAGE/latest.json" \
    --repo "$REPO" --target "$(git rev-parse HEAD)" --title "Shift $VERSION" --notes "$NOTES"
  git fetch -q --tags origin
  echo "Published Shift $VERSION: https://github.com/$REPO/releases/tag/v$VERSION"
else
  echo "Staged Shift $VERSION in $STAGE. Publish with: scripts/release.sh --publish \"notes\""
fi

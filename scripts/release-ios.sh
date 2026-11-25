#!/bin/sh
# Builds Shift for iPhone, signed for App Store Connect, and with --upload sends it to TestFlight.
#   scripts/release-ios.sh            build the .ipa only
#   scripts/release-ios.sh --upload   build it and upload it; it shows in TestFlight once Apple has processed it
# The build number is the commit count, so every upload from a new commit is higher than the last.
#
# One-time setup on the release Mac: the App Store Connect API key in the Keychain (see scripts/release.sh), and the
# team's Apple Distribution certificate (with its private key) in the login Keychain plus the "Shift App Store"
# provisioning profile installed, both made through the App Store Connect API.
set -eu
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "error: commit or stash your changes first; a release builds only what's committed" >&2
  exit 1
fi

APPLE_API_KEY=48ZXPM47P5
APPLE_API_ISSUER=e93b6d82-6953-48c7-b0e0-e62e78812854
KEY_DIR=$(mktemp -d)
# The build writes its build number into the tracked Info.plist; put it back so the tree stays clean.
trap 'rm -rf "$KEY_DIR"; git checkout -- src-tauri/gen/apple/app_iOS/Info.plist' EXIT
APPLE_API_KEY_PATH=$KEY_DIR/AuthKey_$APPLE_API_KEY.p8
(umask 077 && security find-generic-password -s shift-asc-api -a "$APPLE_API_KEY" -w | base64 -d >"$APPLE_API_KEY_PATH")
export APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH

BUILD=$(git rev-list --count HEAD)
bun install --frozen-lockfile
ARCHIVE=src-tauri/gen/apple/build/app_iOS.xcarchive
OUT=src-tauri/gen/apple/build/export
STARTED=$(mktemp)
# Tauri's own export uses automatic signing, which asks Apple's cloud signing for a certificate; an App Manager key
# isn't allowed to. So its export step fails by design, and the archive is exported below with the local Apple
# Distribution certificate and the "Shift App Store" profile (scripts/ios-export-options.plist).
bun run tauri ios build --export-method app-store-connect --config "{\"bundle\":{\"iOS\":{\"bundleVersion\":\"$BUILD\"}}}" || true
if [ -z "$(find "$ARCHIVE/Info.plist" -newer "$STARTED" 2>/dev/null)" ]; then
  echo "error: the build didn't produce a new archive; see the output above" >&2
  exit 1
fi
rm -rf "$OUT"
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist scripts/ios-export-options.plist -exportPath "$OUT"
IPA=$OUT/Shift.ipa
echo "built $IPA (build $BUILD)"

if [ "${1:-}" = "--upload" ]; then
  # altool finds the key by its ID in this folder.
  API_PRIVATE_KEYS_DIR=$KEY_DIR xcrun altool --upload-app --type ios --file "$IPA" \
    --apiKey "$APPLE_API_KEY" --apiIssuer "$APPLE_API_ISSUER"
fi

#!/bin/sh
# Builds Shift for iPhone, signed for App Store Connect, and with --upload sends it to TestFlight.
#   scripts/release-ios.sh            build the .ipa only
#   scripts/release-ios.sh --upload   build it and upload it; it shows in TestFlight once Apple has processed it
# The build number is the commit count, so every upload from a new commit is higher than the last.
#
# One-time setup on the release Mac: the App Store Connect API key in the Keychain (see scripts/release.sh). Xcode
# signs automatically with that key, creating the distribution certificate and profile on the first run.
set -eu
cd "$(dirname "$0")/.."

if [ -n "$(git status --porcelain)" ]; then
  echo "error: commit or stash your changes first; a release builds only what's committed" >&2
  exit 1
fi

APPLE_API_KEY=48ZXPM47P5
APPLE_API_ISSUER=e93b6d82-6953-48c7-b0e0-e62e78812854
KEY_DIR=$(mktemp -d)
trap 'rm -rf "$KEY_DIR"' EXIT
APPLE_API_KEY_PATH=$KEY_DIR/AuthKey_$APPLE_API_KEY.p8
(umask 077 && security find-generic-password -s shift-asc-api -a "$APPLE_API_KEY" -w | base64 -d >"$APPLE_API_KEY_PATH")
export APPLE_API_KEY APPLE_API_ISSUER APPLE_API_KEY_PATH

BUILD=$(git rev-list --count HEAD)
bun install --frozen-lockfile
bun run tauri ios build --export-method app-store-connect --config "{\"bundle\":{\"iOS\":{\"bundleVersion\":\"$BUILD\"}}}"
IPA=$(ls src-tauri/gen/apple/build/arm64/*.ipa)
echo "built $IPA (build $BUILD)"

if [ "${1:-}" = "--upload" ]; then
  # altool finds the key by its ID in this folder.
  API_PRIVATE_KEYS_DIR=$KEY_DIR xcrun altool --upload-app --type ios --file "$IPA" \
    --apiKey "$APPLE_API_KEY" --apiIssuer "$APPLE_API_ISSUER"
fi

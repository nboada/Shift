# Shift for iPhone: plan

Goal: Shift on iPhone through TestFlight, built from the same Rust core and TypeScript UI as the Mac app (Tauri 2 mobile). Not a rewrite.

## Where it stands (branch `plan/ios-app`)

Tried on 2026-11-25:

- **The Rust core builds for iOS.** `cargo check --target aarch64-apple-ios` and `aarch64-apple-ios-sim` both pass, and clippy is clean for the simulator. Every dependency compiles: TLS (rustls / aws-lc-rs), SQLite, reqwest, IMAP and SMTP.
- **What it took:**
  - The Keychain crate needs its `protected` feature on iOS (`Cargo.toml`, iOS-only dependency line).
  - Three Mac-only features are fenced off with Tauri's `desktop` cfg: the app menu, window size and position (`tauri-plugin-window-state`), and Open at login (`auto-launch`).
  - Updates are off on iOS (`updates_enabled`): they come through TestFlight and the App Store.
  - The Mac app is unchanged: clippy is clean, all 65 tests pass, and `cargo fmt` is clean.
- **Xcode project generated:** `bun run tauri ios init` created `src-tauri/gen/apple` (bundle id `au.com.talkk.shift`).
- **The UI already has a phone layout.** Under 760px it shows one column: mailboxes → list → reader, with Back buttons, safe-area padding for the notch, and swipe actions on rows.
- **Blocked on the iOS Simulator runtime.** `tauri ios build --target aarch64-sim` stops at "Xcode Simulator SDK 27.2 is not installed". Install it in Xcode → Settings → Components → iOS 27.2 (several GB), then run `bun run tauri ios dev`.

## Decisions for Nic

1. **New mail while Shift is closed.**
   - **Recommended: iOS Background App Refresh plus local notifications.** iOS wakes the app a few times an hour at its own discretion, it syncs and announces new mail, and there's still no Shift server. Notifications can arrive minutes late.
   - **Real push:** Gmail `users.watch` → Google Pub/Sub → a small relay → Apple's push service. Instant, but it's a server that receives your mailbox's change notices. That breaks "Shift servers: 0" and the privacy policy would need to say so.
2. **Google sign-in on iOS.**
   - Google doesn't allow the desktop flow's loopback redirect (`127.0.0.1:<port>`) for iOS apps. Add an **iOS OAuth client** in the same Google Cloud project: no secret, redirect `com.googleusercontent.apps.<id>:/oauthredirect`.
   - Catch the redirect with `ASWebAuthenticationSession`, through a small Swift plugin or `tauri-plugin-deep-link`.
   - The restricted `mail.google.com` scope stays the same, and the project's verification and CASA cover it. Ask Google whether adding a client during the current review needs a note.
3. **iPhone only at first.** iPad can use the Mac's three-column layout later. Recommended: iPhone only for TestFlight.

## Phases

### 1. Running in the simulator (about a day)

- Install the iOS Simulator runtime (above). Then run `bun run tauri ios dev`.
- **Demo mode on the simulator.** `SHIFT_DEMO` is an environment variable on the Mac. On iOS use a build-time switch, a `demo` cargo feature: `bun run tauri ios dev --features demo`.
- **Bring the app back up to date.** The sync loop is a tokio task, and iOS suspends the app in the background. On returning to the foreground, sync right away (Tauri's `RunEvent::Resumed`) instead of waiting for the next tick.

### 2. Phone UI pass (2–4 days)

The one-column layout exists; this is about touch.

- **Hover-only controls need a tap equivalent:**
  - row hover actions: swipe already exists, plus a long press;
  - tooltips;
  - right-click menus: long press opens the same `Menu`.
- **Touch targets and typing:**
  - Touch targets at least 44×44pt.
  - Inputs at 16px or larger, so iOS doesn't zoom on focus.
  - A viewport meta tag with `viewport-fit=cover`.
- **Full-screen sheets on the phone:** the composer, Settings and the ⌘K palette.
- **Mac-only controls hidden:**
  - keyboard shortcut hints and the shortcut settings;
  - Open at login, Check for updates, and the updates section;
  - the window controls inset.
- **Safe areas:** the bottom area (home indicator) for the composer's Send bar and the toolbar.

### 3. iOS behaviour (3–5 days)

- **Google sign-in:** the iOS OAuth client and `ASWebAuthenticationSession` (decision 2). `auth::sign_in` gets an iOS branch with the same PKCE code and a different redirect.
- **IMAP accounts:** they work as they are (password in the Keychain; plain TCP + TLS is allowed on iOS).
- **Attachments:** iOS has no Downloads folder and no `xattr` quarantine. `open_attachment` gets an iOS branch: write to the app's temp folder, then open Quick Look or the share sheet (a small Swift plugin, or the opener plugin if it covers it).
- **Notifications:** ask for permission on first launch after sign-in. Tapping a notification opens the email; the existing `open-from-notification` event already does this, without the desktop window calls.
- **Background refresh (decision 1):** a Swift plugin registers a `BGAppRefreshTask`, runs one `sync` with a time limit, then reschedules.
- **Keychain:** items stay readable after first unlock (`kSecAttrAccessibleAfterFirstUnlock`), so background refresh can sign in.
- **Storage:** IMAP accounts keep raw messages. On a phone, cap the window (`imap::WINDOW`) or keep bodies only for recent mail. Gmail accounts already fetch bodies on demand.

### 4. TestFlight (1–2 days, mostly Apple's paperwork)

- **App Store Connect:**
  - Apple Developer Program: the same membership (team `65AK786Q34`) that signs the Mac app.
  - Register the bundle id `au.com.talkk.shift` for iOS, and create the app record. It can be one record with the Mac app later (universal purchase).
  - Signing: Xcode automatic signing with the team; an Apple Distribution certificate and an App Store provisioning profile.
- **The app bundle:**
  - The app icon at 1024px, no transparency (the generated set comes from `icons/`).
  - A privacy manifest (`PrivacyInfo.xcprivacy`) listing the required-reason APIs used.
  - `ITSAppUsesNonExemptEncryption = NO`: Shift uses only standard TLS.
  - App Privacy answers matching the site's privacy policy, with the privacy policy URL.
- **Release script:** `scripts/release-ios.sh`:
  1. `bun run tauri ios build --export-method app-store-connect`
  2. upload with `xcrun altool --upload-app`, using an App Store Connect API key from the Keychain.
- **Testers:** internal TestFlight testers (up to 100 people on the team) need no review. External testers need a short beta review.

### Later

iPad layout, a share extension (share to Shift), widgets (unread count), and real push if decision 1 changes.

## Risks

- **Google's review.** If they want the iOS client reviewed separately, TestFlight for Gmail accounts waits on them. IMAP accounts don't depend on Google.
- **WKWebView on iOS.** The UI uses `popover`, `:has()`, `color-mix()` and `dialog`, all supported in recent iOS Safari, but test them in phase 1.
- **Background refresh is best effort.** iOS decides when it runs, and less often for apps that are rarely opened.
- **Memory and storage on older phones** with several large accounts. Measure in phase 1.

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
- **Runs in the simulator in demo mode** (iPhone 17, iOS 27.0): Inbox, reader and onboarding work. The `demo` cargo feature turns on the demo mailbox, since an iOS app gets no `SHIFT_DEMO` variable.
- **Run it:** `bun run tauri ios dev "iPhone 17" --features demo` (needs the iOS Simulator runtime that matches Xcode's SDK, from Xcode → Settings → Components).

## Decisions (Nic, 2026-11-25)

1. **New mail while Shift is closed: real push.** Gmail `users.watch` → Google Pub/Sub → a small relay (a Cloudflare Worker beside the site's) → Apple's push service (APNs). Instant, but the relay sees which mailbox changed (a Gmail history id, no mail content), so "Shift servers: 0" and the privacy policy change before it ships. IMAP accounts have no push hook: they refresh when the app opens or iOS gives it background time.
2. **Google sign-in on iOS: an iOS OAuth client** in the same Google Cloud project: no secret, redirect `com.googleusercontent.apps.<id>:/oauthredirect`, caught with `ASWebAuthenticationSession`. The `mail.google.com` scope and the project's verification stay the same.
3. **iPhone only** for TestFlight. iPad later.

## Phases

### 1. Running in the simulator (about a day)

- Done: running on the simulator, demo mode via the `demo` feature, the list below the notch, hover-only row actions hidden on touch screens.
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
- **Push (decision 1):** register for remote notifications (a Swift plugin hands the APNs device token to Rust), send it with the account's watch to the relay, and renew `users.watch` every few days. A push wakes the app for one `sync` with a time limit, then a local notification as today. An APNs key (.p8) from the developer account goes to the relay as a Worker secret.
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

iPad layout, a share extension (share to Shift), widgets (unread count).

## Risks

- **Google's review.** If they want the iOS client reviewed separately, TestFlight for Gmail accounts waits on them. IMAP accounts don't depend on Google.
- **WKWebView on iOS.** The UI uses `popover`, `:has()`, `color-mix()` and `dialog`, all supported in recent iOS Safari, but test them in phase 1.
- **Push needs a server.** The relay is the first Shift server: it must keep no mail, and its outage only delays alerts (the app still syncs when opened). iOS also limits background wake-ups for apps that are rarely opened.
- **Memory and storage on older phones** with several large accounts. Measure in phase 1.

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
- **The iPhone has its own interface** (issue #42): mailboxes → conversation list → conversation on a navigation stack, in `src/mobile/`, on the same mail core as the Mac.
- **Runs in the simulator in demo mode** (iPhone 17, iOS 27.0): Inbox, reader and onboarding work. The `demo` cargo feature turns on the demo mailbox, since an iOS app gets no `SHIFT_DEMO` variable.
- **Run it:** `bun run tauri ios dev "iPhone 18 Pro Max" --features demo` (needs the iOS Simulator runtime that matches Xcode's SDK, from Xcode → Settings → Components).

## Decisions (Nic, 2026-11-25)

1. **New mail while Shift is closed: real push.** Gmail `users.watch` → Google Pub/Sub → a small relay (a Cloudflare Worker beside the site's) → Apple's push service (APNs). Instant, but the relay sees which mailbox changed (a Gmail history id, no mail content), so "Shift servers: 0" and the privacy policy change before it ships. IMAP accounts have no push hook: they refresh when the app opens or iOS gives it background time.
2. **Google sign-in on iOS: an iOS OAuth client** in the same Google Cloud project: no secret, redirect `com.googleusercontent.apps.<id>:/oauthredirect`, caught with `ASWebAuthenticationSession`. The `mail.google.com` scope and the project's verification stay the same.
3. **iPhone only** for TestFlight. iPad later.

## Phases

### 1. Running in the simulator (about a day)

- Done: running on the simulator, demo mode via the `demo` feature, the list below the notch, hover-only row actions hidden on touch screens.
- **Bring the app back up to date:** done. `RunEvent::Resumed` starts a sync when the app returns to the foreground.

### 2. Phone UI pass (2–4 days)

Rebuilt as a phone interface on a shared core (issue #42), in six steps:

1. **Shared mail core:** done. `src/core/mail.ts`, tested against a fake backend; `main.ts` is the desktop UI on it.
2. **Phone shell, list and reader:** done (2026-11-26), checked in the demo on the iPhone 18 Pro Max simulator. `src/mobile/`: a navigation stack (push and pop with the app's easing, edge swipe back, back button named after the screen underneath, scroll kept, large titles), the Mailboxes screen (mailboxes, labels, unread counts, all accounts or one), the conversation list (Smart Inbox sections, pull to refresh, load more, empty states, swipe actions from Settings → Swipes with Undo, basic search, compose) and the conversation (message cards shared with the Mac through `src/email-view.ts`, wide emails scaled to fit, Load images, invites, attachments to the share sheet, archive, delete, move and labels, mark unread, reply, next and previous). Compose, Settings and onboarding still open the Mac's versions.
3. Compose sheet.
4. Search screen, organising sheets, multi-select, long-press menus.
5. Settings, onboarding and AI on the phone.
6. Remove the old phone overrides from `styles.css`.

The notes below are from before the rebuild; what's left of them belongs to steps 3–6.

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

- **Google sign-in:** done. The iOS OAuth client (`GOOGLE_IOS_CLIENT_ID`, no secret) through the system sheet (`tauri-plugin-web-auth`, ASWebAuthenticationSession); tokens go to the data-protection Keychain, readable after first unlock.
- **IMAP accounts:** they work as they are (password in the Keychain; plain TCP + TLS is allowed on iOS).
- **Attachments:** done. On iOS a tap hands the file to the share sheet (`navigator.share`), which previews it and offers Save to Files and other apps; no native code.
- **Notifications:** permission is asked once there's an account (`ask_to_notify`). Still to check: tapping a notification opens the email (`open-from-notification`).
- **Push (decision 1):** register for remote notifications (a Swift plugin hands the APNs device token to Rust), send it with the account's watch to the relay, and renew `users.watch` every few days. A push wakes the app for one `sync` with a time limit, then a local notification as today. An APNs key (.p8) from the developer account goes to the relay as a Worker secret.
- **Keychain:** items stay readable after first unlock (`kSecAttrAccessibleAfterFirstUnlock`), so background refresh can sign in.
- **Storage:** IMAP accounts keep raw messages. On a phone, cap the window (`imap::WINDOW`) or keep bodies only for recent mail. Gmail accounts already fetch bodies on demand.

### 4. TestFlight: done (build 174, 2026-11-26)

- App Store Connect app "Shift Mail" (`6839177782`), bundle id `au.com.talkk.shift`, iPhone only, portrait.
- Internal group "Shift team" gets every build. Internal testers need no review.
- `scripts/release-ios.sh --upload` builds, exports with the team's Apple Distribution certificate and the "Shift App Store" profile, and uploads with the App Store Connect API key. Every build number is the commit count.
- Before external testers or the App Store: App Privacy answers matching the privacy policy, screenshots, and a beta review.

### Later

iPad layout, a share extension (share to Shift), widgets (unread count).

## Risks

- **Google's review.** If they want the iOS client reviewed separately, TestFlight for Gmail accounts waits on them. IMAP accounts don't depend on Google.
- **WKWebView on iOS.** The UI uses `popover`, `:has()`, `color-mix()` and `dialog`, all supported in recent iOS Safari, but test them in phase 1.
- **Push needs a server.** The relay is the first Shift server: it must keep no mail, and its outage only delays alerts (the app still syncs when opened). iOS also limits background wake-ups for apps that are rarely opened.
- **Memory and storage on older phones** with several large accounts. Measure in phase 1.

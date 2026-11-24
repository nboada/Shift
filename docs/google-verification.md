# Google OAuth verification for Shift

What TALKK needs to get Shift's Google Cloud project (`shift-mail-talkk`, app name **Shift**, External, currently in Testing) verified for the restricted scope `https://mail.google.com/`. Written 2026-11-24 against the code on `main` and Google's documentation as of that date (sources at the end). Anything marked **unconfirmed** could not be checked in the docs or the code.

Contents:

1. Scope justification (paste into the Data access / Verification centre forms)
2. Demo video shot list
3. Security assessment (CASA) checklist and gaps
4. Submission steps, timelines and costs
5. Gaps to fix before submitting
6. Sources

---

## 1. Scope justification

### Short version (for the "How will the scopes be used?" field)

> Shift is a desktop email client for macOS. Users read, search, compose, send, schedule, label, archive, trash and permanently delete their Gmail mail in Shift's own interface. Shift requests https://mail.google.com/ because it is a full email client, and because its "Empty Trash" and "Empty Spam" commands permanently delete mail with users.messages.batchDelete, which accepts only https://mail.google.com/. gmail.modify cannot permanently delete mail, gmail.readonly cannot change or send mail, and gmail.send cannot read it. Shift has no servers: mail is fetched from the Gmail API straight to the user's Mac, cached in a local database on that Mac, and refresh tokens are stored in the macOS Keychain. No Google user data is sent to TALKK or any third party, no person at TALKK can read it, and Shift has no analytics or telemetry.

### Feature by feature

All calls go from the user's Mac directly to `https://gmail.googleapis.com/gmail/v1/users/me` (`BASE` in `src-tauri/src/gmail.rs:13`), or to `https://gmail.googleapis.com/upload/gmail/v1/users/me` for large messages (`gmail.rs:14`). The scope is requested in one place: `SCOPE` in `src-tauri/src/auth.rs:10`.

| # | User-facing feature (UI label) | What Shift does with Gmail data | Gmail API calls | Code |
|---|---|---|---|---|
| 1 | **Sign in with Google** (first-run screen), **Add a Google account** (⌘K, Settings → Accounts) | Gets the signed-in address and the current history id so the account can be listed and synced. | `users.getProfile` | `gmail.rs:300` `profile`; `lib.rs:244` |
| 2 | Mailbox list and reader: Inbox, Pinned, Drafts, Sent, Scheduled, All Mail, Spam, Trash, user labels in the sidebar | Lists threads and downloads each thread's messages (headers, bodies, attachment details) into the local cache so the UI can show them offline. Lists labels for the sidebar and label colours. | `users.threads.list`, `users.threads.get` (`format=full` or metadata), `users.labels.list` | `gmail.rs:318` `thread_ids`, `:352` `thread`, `:308` `labels`; `lib.rs:218`, `:245`, `:368` |
| 3 | Background sync and **Check for mail** (↻ button, ⌘R) | Every sync interval (30 s by default), fetches only what changed since the last stored history id, then re-fetches those threads. Shows a macOS notification for new unread Inbox mail (built from the local cache, nothing leaves the Mac). | `users.history.list`, then `users.threads.get` | `gmail.rs:366` `history`; `lib.rs:374`; notifications `lib.rs:279` |
| 4 | **Search mail** (search field, `/`, ⌘F) | Sends the user's query to Gmail to find mail that isn't in the local cache, then fetches the matching threads. | `users.threads.list` with `q` | `lib.rs:851` `search`, `:869` |
| 5 | Attachments in the reader (click to save to Downloads and open), inline `cid:` images, forwarding with attachments | Downloads an attachment's bytes only when the user opens it, or when forwarding the original's files. | `users.messages.attachments.get` | `gmail.rs:582` `attachment`; `lib.rs:1225` `attachment_data`, `:1321` `open_attachment` |
| 6 | **Compose**, **Reply**, **Reply all**, **Forward**, **Send** | Builds the MIME message on the Mac and sends it. While the user types, the draft is saved to Gmail Drafts (so it appears on their other devices); sending a saved draft sends that draft. **Discard draft** deletes it. Messages over about 3 MB go through the media upload endpoint. | `users.messages.send`, `users.drafts.create`, `users.drafts.update`, `users.drafts.send`, `users.drafts.delete` | `gmail.rs:529` `send`, `:542` `save_draft`, `:569` `send_draft`, `:589` `delete_draft`; `lib.rs:1021` `send`, `:1158`, `:1184` |
| 7 | **Send later** (clock next to Send: Later today, Tomorrow morning, This weekend, Next week, Pick Date & Time…) and the **Scheduled** mailbox (Edit, Send now, Cancel send) | Gmail's API has no scheduled send, so the email is saved as a Gmail draft and the sync loop on the user's Mac sends it when it is due. The schedule is kept in the local database only. | `users.drafts.create` / `update`, then `users.drafts.send` (or `users.messages.send`) | `lib.rs:1069` `schedule_send`, `:1128` `send_due` |
| 8 | **Archive**, **Mark as read / unread**, **Pin / Unpin**, **Move to…**, **Label…**, **Spam / Mark as spam**, and **Undo** (⌘Z) | Adds or removes labels on a thread (INBOX, UNREAD, STARRED, SPAM, user labels). The change is made in the local cache first, then in Gmail; if Gmail refuses, the thread is re-fetched to undo it. | `users.threads.modify` | `gmail.rs:391` `modify`; `lib.rs:806` `modify`, `:836` |
| 9 | **Delete** (moves to Trash) and moving a thread out of Trash | Moves a thread to Trash, or restores it and applies the new labels. | `users.threads.trash`, `users.threads.untrash` | `gmail.rs:478`, `:468`; `lib.rs:828`, `:831` |
| 10 | **Mark all as read** (right-click a mailbox) | Lists the unread messages in that mailbox and removes UNREAD from all of them in one call per 1,000 messages. | `users.messages.list`, `users.messages.batchModify` | `gmail.rs:402` `message_ids`, `:431` `batch_modify`; `lib.rs:585` |
| 11 | Right-click a label: **Rename…**, **Colour**, **Delete label** | Renames or recolours a user label, or deletes it, in Gmail and then in the cache. | `users.labels.patch`, `users.labels.delete` | `gmail.rs:456` `patch_label`, `:462` `delete_label`; `lib.rs:690` `edit_label` |
| 12 | **Empty Trash** / **Empty Spam** (button above the list, or right-click Trash/Spam), after a confirmation that says the mail "is deleted for good, in Gmail too" | Lists every message in Trash or Spam and permanently deletes them. This is the one feature that needs the full scope. | `users.messages.list`, `users.messages.batchDelete` | `gmail.rs:444` `batch_delete`; `lib.rs:639` `empty_mailbox`; confirmation `src/main.ts:802` |

**Label creation is not in the code.** The brief listed "label create", but there is no call to `users.labels.create` in `src-tauri/` and no "New label" item in `src/main.ts` as of this commit. Either leave it out of the submission, or add the feature and a row here (it would use `users.labels.create`) before recording the video. Don't describe features the app doesn't have: Google rejects scope requests based on "future enhancements".

### Why narrower scopes are not enough

| Narrower scope | What it allows | Which Shift features break |
|---|---|---|
| `gmail.readonly` | Read mail and settings. | Everything that changes mail: send, drafts, scheduled send, archive, read/unread, pin, labels, spam, trash, Empty Trash/Spam. |
| `gmail.send` | Send only. | Reading and syncing the mailbox (the core of the app), drafts, every mailbox action. |
| `gmail.compose` | Drafts and send. | Reading the mailbox, labels, archive, trash, Empty Trash/Spam. |
| `gmail.modify` | Read, compose, send, label, trash. Explicitly excludes permanent deletion. | **Empty Trash** and **Empty Spam**: `users.messages.batchDelete` lists only `https://mail.google.com/` as its authorization scope, and Gmail returns 403 insufficient scope under `gmail.modify` (Shift detects this error in `gmail::is_scope_error` and tells the user to sign in again). |
| `gmail.modify` + `gmail.send` + `gmail.compose` together | As above. | Same: none of them grants permanent deletion. |

Permanently emptying Trash and Spam is a standard feature of desktop mail clients (Apple Mail, Outlook, Spark) and users expect it from one. Without it, mail the user deleted stays in their Google storage for 30 days and counts against their quota.

### Data stays on the device

- No TALKK servers. The app talks only to `accounts.google.com`, `oauth2.googleapis.com` and `gmail.googleapis.com`. There is no backend, no proxy and no relay.
- Mail is cached in one SQLite file per account in the app's data folder on the Mac (`accounts/<email>.sqlite3`).
- Refresh tokens are stored in the macOS Keychain, one item per account (`auth.rs:48` `keychain`). Access tokens are held in memory only.
- No analytics, crash reporting or telemetry: none of these SDKs is in `src-tauri/Cargo.toml` or `package.json`.
- **Sign out** deletes that account's database and its Keychain item (`lib.rs:491`).
- The privacy policy at https://shift.talkk.com.au/privacy already says this and includes the Limited Use statement.

---

## 2. Demo video shot list

Google's requirements for the video: show the whole OAuth grant flow in English, the consent screen showing the correct app name, the browser address bar on the consent screen showing the app's OAuth client ID, and every feature that uses the requested scopes. Upload to YouTube as **Unlisted**.

**Before recording:**

- Record a **release build signed in to a real Gmail test account**, not `bun run demo`. Demo mode never calls Gmail, so it doesn't show the scope being used.
- The build must use the **same OAuth client ID** that is in the Cloud project being verified (`GOOGLE_CLIENT_ID` baked in by `build.rs`). If the project has more than one client, Google wants each shown; delete clients you don't ship (Google recommends this too).
- Use a test account with some real-looking mail: a few threads with attachments, one user label, a few messages in Trash and Spam.
- Set the Mac and browser to English. On Google's consent screen, check the language picker at the bottom left says English.
- Before the first shot, remove any earlier Shift grant at myaccount.google.com/permissions so the full consent screen appears (Shift sends `prompt=consent`, so it should appear anyway).
- Keep a Gmail web tab open in the same browser so you can show that each action in Shift reaches Gmail. This isn't a stated requirement, but it makes the "uses the scope" part hard to misread.
- Record at 1080p or higher and zoom the browser so the URL is readable. Add captions in the edit: the lines in quotes below can be spoken narration or on-screen captions.

| Shot | What's on screen | Narration / caption |
|---|---|---|
| 1. Intro | Shift launched for the first time: the **Shift** card, "Fast Gmail, stored on your Mac.", **Sign in with Google** button. | "This is Shift, a Gmail client for macOS made by TALKK. It runs entirely on the Mac and has no servers." |
| 2. Start sign-in | Click **Sign in with Google**. The default browser opens on Google's sign-in page. Pick or sign in to the test account. | "Clicking Sign in with Google opens Google's sign-in page in the browser." |
| 3. Client ID in the URL bar | On the consent screen, click into the address bar so the whole URL is visible, and slowly scroll or zoom to the `client_id=…apps.googleusercontent.com` parameter. Hold for 3 seconds. Optionally cut to the Google Auth Platform **Clients** page showing the same client ID. | "The address bar shows Shift's OAuth client ID, ending in …apps.googleusercontent.com." |
| 4. Consent screen | The full consent screen: app name **Shift**, the permission line for full Gmail access ("Read, compose, send, and permanently delete all your email from Gmail", wording **unconfirmed**: record whatever Google shows), and the language set to English. Click **Continue** / **Allow**. | "The consent screen shows the app name, Shift, and the one permission it asks for: full access to Gmail, which it needs to read, send, organise and permanently delete mail." |
| 5. Signed in | The browser tab says "Signed in. You can close this tab." Switch back to Shift: the Inbox fills in. | "Shift receives the authorisation on the Mac itself. The sign-in token is stored in the macOS Keychain." |
| 6. Reading mail (feature 1–2) | Click through Inbox, open a thread in the reader, expand messages, open a label in the sidebar, then Sent and All Mail. | "Shift downloads the user's threads, messages and labels from the Gmail API and stores them in a database on this Mac, so mail opens instantly." |
| 7. Sync (feature 3) | In Gmail web, send the test account an email from another account (or star a thread in Gmail web). In Shift, press ⌘R or the **Check for mail** button; the change appears and a notification shows. | "Shift checks Gmail's history for changes every 30 seconds, or when you press Check for mail, and shows a notification for new mail." |
| 8. Search (feature 4) | Type a query in **Search mail** that finds an old email. | "Search asks Gmail for matching mail, including mail that isn't stored on the Mac yet." |
| 9. Attachments (feature 5) | Open a thread with an attachment, click the file chip; it saves to Downloads and opens. | "Attachments are downloaded from Gmail only when you open them." |
| 10. Compose and send (feature 6) | Click **Compose** (⌘N). Fill To, Subject and body; show the draft status saving; attach a file with the paperclip. Click **Send**; show the "Sending in 5s… Undo" toast. Show the email arriving in Gmail web's Sent. | "Compose writes a draft to Gmail Drafts as you type, then sends the email through the Gmail API. It appears in Sent in Gmail." |
| 11. Reply and forward (feature 6) | Open a thread, click **Reply**, type, send. Then **Forward** a message with an attachment. | "Replies and forwards open under the thread and are sent through Gmail, with the original attachments when forwarding." |
| 12. Send later (feature 7) | Compose an email, click the clock (**Send later**), choose **Pick Date & Time…** two minutes ahead, click **Schedule**. Open the **Scheduled** mailbox to show it waiting. Wait (or cut) until it's due, and show it in Gmail web's Sent. Optionally right-click a scheduled email → **Send now**. | "Send later saves the email as a Gmail draft. Shift sends it at the chosen time from this Mac." |
| 13. Mailbox actions (feature 8) | On a thread: **Archive**, then ⌘Z to undo; **Mark unread**; **Pin**; **Label…** and tick a label; **Move to…** a label; **Spam**. After each, show the same change in Gmail web. | "Archive, read and unread, pin, labels, move and spam change the thread's labels in Gmail." |
| 14. Trash (feature 9) | **Delete** a thread; show it in Trash in Shift and in Gmail web. Move it back to the Inbox with **Move to…**. | "Delete moves the thread to Gmail's Trash, and it can be moved back." |
| 15. Mark all as read (feature 10) | Right-click a mailbox with unread mail → **Mark all as read**. | "Mark all as read updates every message in that mailbox in one Gmail request." |
| 16. Label management (feature 11) | Right-click a user label in the sidebar → **Rename…**, then **Colour**, then **Delete label**. Show each in Gmail web's label list. | "Labels can be renamed, recoloured and deleted, and Gmail is updated." |
| 17. Empty Trash / Spam (feature 12) | Open **Trash**, click **Empty Trash**; show the confirmation "Empty Trash? Everything in Trash is deleted for good, in Gmail too. This can't be undone." and confirm. Show Trash empty in Gmail web. Repeat for **Empty Spam** if there's spam. | "Empty Trash and Empty Spam permanently delete mail with Gmail's batch delete, after a confirmation. This is the feature that needs full Gmail access: the narrower gmail.modify scope cannot permanently delete mail." |
| 18. Data stays local, sign out | Open Settings (⌘,) → Accounts and sign out of the account; show the confirmation. Optionally show myaccount.google.com/permissions where access can be removed. | "All mail stays on this Mac. Signing out deletes the account's local mail and its token from the Keychain. Access can also be removed in the Google Account settings." |

Keep the order of shots 6–17 the same as the table in section 1, so a reviewer can match each feature to its justification.

---

## 3. Security assessment (CASA)

### Does Shift need one?

Google's documents disagree a little, so plan for it but ask:

- The developer guide says: "If you store or transmit restricted scope data on servers, then you need to complete a security assessment", and "Every app that requests access to Google users' restricted data and has the ability to access data from or through a third-party server must go through a security assessment". Shift has no server, so on this wording it may be exempt.
- The Help Center's Security Assessment page says apps requesting restricted scopes "must undergo an annual security assessment", and that "the Google Trust and Safety team will contact you when it is time to initiate the security assessment process."
- The Workspace user data policy says restricted-scope apps must follow CASA, and "depending on the API being accessed and number of user grants or users, we may also require" a periodic assessment and Letter of Assessment.

So: state plainly in the submission that Shift has no servers and all data stays on the user's device (section 1), and let Google decide. **Unconfirmed** whether Google will waive the assessment for Shift; if Trust and Safety asks for one, it's the step below. Get the checklist in shape either way, since the policy's required security measures apply regardless.

### Which level

CASA now uses **assurance levels** rather than the old "Tier 2/Tier 3" names: **AL1** and **AL2**, both lab-tested by an ADA authorised lab. Google, not the developer, picks the level from the data's sensitivity, user count and risk signals. A new app with few users is likely to get AL1 (the former Tier 2). **Unconfirmed** until Google assigns it. All CASA requirements apply at every level; only the assessment method differs. Labs mostly test web apps and APIs (DAST scans, a self-assessment questionnaire, then revalidation), so for a desktop app with no backend most server-side items will be "not applicable" and the lab will look at the app itself, possibly from source code. **Unconfirmed** how a given lab handles desktop-only apps: ask before paying.

### Checklist

The CASA categories below come from the App Defense Alliance CASA page. The "required security measures" come from the Google Workspace user data policy. I didn't map individual ASVS requirement IDs.

| Area | What's asked | How Shift answers | Status |
|---|---|---|---|
| Authentication / OAuth integration | Secure OAuth flow, no tokens in URLs, state checked. | Desktop loopback flow with PKCE (S256) and a random `state`, checked on return (`auth.rs:111` `sign_in`). The redirect goes to `127.0.0.1` on a random port. Only the auth code crosses the redirect, and it's exchanged with the verifier. `prompt=consent select_account`. | Done |
| Client secret | Secrets stored securely, not hard-coded. | The Desktop client "secret" is baked into the binary by `build.rs`. Google documents that installed-app secrets aren't confidential, and PKCE protects the flow (`auth.rs:34` comment). A scanner may still flag it as a hard-coded secret: be ready to explain. | Explain |
| Token storage at rest | "Keeping user data and credentials, specifically tokens such as OAuth access and refresh tokens, encrypted at rest"; keys in a hardware or equivalent key store. | Refresh tokens are in the macOS Keychain via `keyring` 4 with the `apple-native-keyring-store` backend (`auth.rs:48`; `Cargo.lock`). Access tokens are memory-only, and expire a minute early (`auth.rs:83`). | Done |
| Session management | Invalidate sessions on logout. | **Sign out** deletes the Keychain item and the local database (`lib.rs:491`), but doesn't revoke the token at Google. | Gap: call `https://oauth2.googleapis.com/revoke` on sign-out |
| Data at rest on the device | Encrypt user data "stored on portable devices or portable electronic media" with an industry-standard method. | The SQLite cache is a plain file in the app data folder. It's protected by macOS user permissions, and by FileVault if the user has it on. | Gap: decide between SQLCipher (encrypted DB, key in Keychain) or documenting reliance on FileVault. **Unconfirmed** whether an assessor accepts FileVault alone |
| Communications | TLS for all traffic. | `reqwest` with `rustls`, HTTPS only to Google endpoints (`Cargo.toml`). The loopback redirect is plain HTTP on 127.0.0.1, as Google's desktop flow requires. | Done |
| Data validation: untrusted email HTML | Sanitise untrusted content, no script execution. | Email HTML renders in a sandboxed iframe with its own CSP `script-src 'none'; form-action 'none'` placed before the email markup; `meta http-equiv` and `base` tags are stripped from the email first (`src/main.ts:355` `cleanEmail`, `:362` `mountEmail`). The frame also inherits the app CSP (`index.html:7`: `default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`). Links open in the system browser only for `http(s):` and `mailto:`. Remote images are blocked by default (`loadRemoteImages: false`, "Load images" bar). | Done, with one weak point (next row) |
| Iframe sandbox | `allow-scripts` + `allow-same-origin` together let a framed page remove its own sandbox. | Shift needs both: WebKit drops the click listener without `allow-scripts`, and sizing needs same-origin (`main.ts:364` comment). Scripts are blocked by two CSPs instead. An assessor may flag the combination. | Explain, or test that no script can run (e.g. `<script>`, `onerror=`, `javascript:` URLs, SVG scripts) and record the result |
| App CSP | No unsafe directives, no dev leftovers. | `style-src 'unsafe-inline'` (emails rely on inline styles); `img-src` allows `http:`; `connect-src` includes `ws://localhost:1420` (the Vite dev server) in release builds too. Tauri's own CSP is `null` because the page sets it (`tauri.conf.json`). | Gap: drop `ws://localhost:1420` and `http:` from the release CSP |
| Untrusted file downloads | Safe handling of files from email. | Attachment names are sanitised (no `/ \ :` or control characters, no leading dot). Files are written with `create_new` so they never follow a symlink or overwrite. They get the `com.apple.quarantine` flag, so Gatekeeper checks apps and Office opens macros in Protected View (`lib.rs:1257` `write_download`, test at `:1646`). Apps and scripts are shown in Finder, not opened. | Done |
| Least privilege in the app | Limit what the webview can do. | Tauri capabilities: `core:default`, `core:window:allow-start-dragging`, `opener:default` only (`src-tauri/capabilities/default.json`). `withGlobalTauri: false`. | Done. `opener:default` scope **unconfirmed**: check it doesn't allow opening arbitrary local paths from the webview |
| Configuration: components up to date | No known-vulnerable dependencies. | No dependency audit is set up (no CI in `.github/`). | Gap: run `cargo audit` and `bun audit`, fix findings, keep the reports |
| Configuration: debug off | No debug modes in production. | Release profile strips symbols and uses `panic = "abort"`. Logs go to stderr only and include account emails and thread ids (`lib.rs:228`, `:382`), not message content. | Mostly done: check devtools are off in release builds |
| Data deletion on request | Show the app can delete user data when asked. | Sign out deletes local mail and token. The privacy policy explains this and links to myaccount.google.com/permissions. Uninstalling the app (dragging it to the Bin) leaves the data folder behind. | Gap: add a "delete all Shift data" path or document where the folder is |
| Telemetry / transfers | Limited Use: no transfers, no human reading. | No analytics, no crash reporting, no servers. | Done |
| AI features | The policy requires prompt injection protection, and any AI provider is a transfer that must be disclosed. | Settings has an AI section placeholder (`soon(...)`) and AI keys go to the Keychain. Nothing is sent anywhere today. | Gap if shipped: don't ship AI features before verification, or disclose them in the privacy policy, video and justification first |
| Google branding | The button that starts the grant must follow Google's branding guidelines. | The first-run button is a plain Shift `primary` button labelled "Sign in with Google" (`index.html:21`), without the Google "G" mark or Google's button style. | Gap: use Google's branded sign-in button style |

---

## 4. Submission steps

Google Auth Platform: `https://console.cloud.google.com/auth/overview?project=shift-mail-talkk`. Field names below are from Google's docs where quoted; where the console's wording may differ, it's marked **unconfirmed**.

### Before you start

1. Fix what you can from section 5, then build and sign the release that the video will show.
2. In **Clients**, delete any OAuth client you don't ship (Google recommends this for verification). Keep the Desktop client whose ID is in the build.
3. Check the project has at least two Owners or Editors, and that the support and developer contact emails are mailboxes someone reads. Google sends verification follow-ups and the yearly re-verification notice there.
4. Upload the demo video to YouTube Studio with **Visibility: Unlisted** and copy the link.

### Branding

1. **Branding** page. Fill in:
   - App name: `Shift`
   - User support email: a TALKK address (e.g. `hello@talkk.com.au`)
   - App logo: the Shift icon, 120×120 px square (size **unconfirmed** for the current console)
   - Application home page: `https://shift.talkk.com.au`
   - Application privacy policy link: `https://shift.talkk.com.au/privacy`
   - Application terms of service link: `https://shift.talkk.com.au/terms`
   - Authorised domains: `talkk.com.au` (already verified in Search Console)
   - Developer contact email: a TALKK address
2. Check the home page meets Google's rules: public, describes what the app does, links to the same privacy policy URL as the consent screen. The live home page links to `/privacy` and `/terms`. Make sure that link resolves to exactly the URL entered above.
3. Click **Verify Branding**. The automated check usually takes a few minutes; fix any issues it lists or request a manual review. When it says **Ready to publish**, click **Publish branding**. Google: brand verification "typically takes 2-3 business days" when the branding has changed.

### Data access

1. **Data access** → **Add or remove scopes**. Add `https://mail.google.com/` and nothing else, apart from any non-sensitive scopes Google pre-fills. Remove any other Gmail scopes left from testing. Shift requests no `openid`, `email` or `profile` scope: it gets the address from `users.getProfile`.
2. Save.

### Audience and Publish app

1. **Audience** → under Publishing status **Testing**, click **Publish app** and confirm, so the status becomes **In production**.
2. Until verification is approved, users see Google's unverified-app warning and have to click **Advanced → Go to Shift (unsafe)**. An unverified app with restricted scopes is capped at 100 users, and the cap counts every account that has ever signed in, test accounts included, so use only a few test accounts (**unconfirmed** for the current rules; this came from the earlier version of this doc and Google's unverified-apps help). Leaving Testing also ends the 7-day refresh-token expiry that Testing imposes (noted in `auth.rs:212`).

### Verification centre

1. **Verification centre** (`https://console.developers.google.com/auth/verification`). It shows Branding status and Data access status. Branding must be published before you can request data-access verification.
2. Start the data access request (button name **unconfirmed**, e.g. "Prepare for verification" / "Submit for verification") and fill in:
   - **Scope justification / how will the scopes be used:** the "Short version" in section 1, and the feature table if there's room or a follow-up asks for detail.
   - **Why narrower scopes aren't sufficient:** the "Why narrower scopes are not enough" table, written out as text.
   - **Demo video:** the unlisted YouTube link.
   - **What features will you use?** (permitted app type): pick the Gmail option matching "Built-in and web email clients that allow users to compose, send, read, and process email via a user interface" (exact option text in the console **unconfirmed**). If unsure, Google says you can leave it blank and they decide.
   - **Up to three documentation links:** `https://shift.talkk.com.au`, `https://shift.talkk.com.au/privacy`, `https://shift.talkk.com.au/terms`.
   - Any question about servers or data storage: "Shift has no servers. Google user data is fetched directly to the user's Mac, stored only there, and never transmitted to TALKK or third parties."
3. Submit. Then watch the contact inboxes: Trust and Safety follows up by email, and the review pauses while it waits for an answer. If they ask for a security assessment, they assign it and you pick an authorised lab.

### Timelines and costs

| Step | Time | Cost | Source |
|---|---|---|---|
| Brand verification | Automated check "usually completes in a few minutes"; "typically takes 2-3 business days" if branding changed | No Google fee found | Google, restricted scope verification guide |
| Restricted scope review | "can potentially take several weeks" (Google gives no fixed figure) | No Google fee found. **Unconfirmed**: Google doesn't publish a fee for verification itself | Google, same guide |
| CASA assessment, if Google asks for one | TAC Security states "Assessment to LoV in 2-3 Weeks" (Basic and Premium AL1), "1-2 Weeks" (Enterprise AL1), "2-4 Weeks" (AL2) | TAC Security list prices: **AL1 Basic $675** (2 revalidation cycles), **AL1 Premium $855** (unlimited revalidation), Enterprise AL1 $4,500, **AL2 $5,400** (USD). Other labs quote per engagement | TAC Security CASA page |
| Annual renewal | Reassessment and re-verification "at least every 12 months after your assessor's Letter of Assessment (LOA) approval date" | Same lab fee again | Google, restricted scope verification guide |

Developers report the whole process takes about a month: one Gmail SaaS reported paying $540 to TAC Security and about a month from start to verified (Reddit, 2025–26). That's anecdotal, not a Google or assessor figure.

---

## 5. Gaps to fix before submitting

In rough order of how likely they are to hold up the review:

1. **Done: label creation.** Label… menu → New label… creates the label in Gmail (`users.labels.create`) and adds it to the email. Rename, colour and delete are in the sidebar's right-click menu.
2. **Done: Google-branded sign-in button.** The first-run screen now uses Google's official "Sign in with Google" artwork (light and dark, from Google's signin-assets.zip), unchanged.
3. **Done: token revocation on sign-out.** Sign out calls `https://oauth2.googleapis.com/revoke` (best effort) before deleting the Keychain item and the cache (`auth::revoke`).
4. **Local mail cache isn't encrypted.** Google's policy requires encrypting user data on portable devices. Decide on SQLCipher with the key in the Keychain, or a written reliance on FileVault (check with the lab first).
5. **Partly done: release CSP.** Release builds drop `ws://localhost:1420` (a Vite build step). `http:` stays in `img-src` on purpose: remote images load only after the user chooses Load images, and many senders still serve images over http.
6. **Done: dependency audit (24 Nov 2026).** `bun audit`: no vulnerabilities in 106 packages. `cargo audit`: no vulnerabilities; 6 warnings, 5 for unmaintained crates (chrono, proc-macro-error, zbus_names, zvariant, zvariant_derive) and 1 unsoundness in `glib` 0.18, a Linux-only GTK dependency that isn't compiled into the macOS app. Re-run both before the assessment and keep the output.
7. **Iframe `allow-scripts allow-same-origin`.** Protected by two CSPs, but expect a question. Write a short test note showing scripts can't run in email frames.
8. **No "delete all data" path beyond sign-out.** Uninstalling leaves the data folder. Add a reset option or document the folder in the privacy policy.
9. **AI features are built and must be disclosed.** Write with AI, Draft a reply, Auto-label and Clean up Inbox send Gmail data (the text, the conversation, or sender/subject/preview) to the AI provider the user configures, from the user's Mac with their own key. The privacy policy now says so (site/src/pages/privacy.astro, "AI features" and Limited Use). Mention it in the scope justification and show one AI feature in the video, or ship the verified build with AI hidden and add it after.
10. **Video must use a real Gmail account and the shipped client ID**, not demo mode.
11. Smaller items: check `opener:default` can't open arbitrary paths from the webview; check devtools are off in release; (done) the bundle identifier and Keychain service are now `au.com.talkk.shift`.

---

## 6. Sources

Fetched 2026-11-24.

- Google, Restricted scope verification (submission steps, video requirements, security assessment wording, timelines): https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification
- Google Cloud Help, Verification requirements (homepage, privacy policy, branding, narrowest scope, video): https://support.google.com/cloud/answer/13464321
- Google Cloud Help, Security Assessment (CASA, AL1/AL2, annual recertification): https://support.google.com/cloud/answer/13465431
- Google Cloud Help, Restricted scopes list: https://support.google.com/cloud/answer/13464325
- Google API Services User Data Policy (Limited Use, secure data handling): https://developers.google.com/terms/api-services-user-data-policy
- Google Workspace user data and developer policy (Gmail permitted app types, required security measures): https://developers.google.com/workspace/workspace-api-user-data-developer-policy
- Gmail API, users.messages.batchDelete (requires `https://mail.google.com/`): https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/batchDelete
- App Defense Alliance, CASA overview and categories: https://appdefensealliance.dev/casa
- App Defense Alliance, CASA assurance levels: https://appdefensealliance.dev/casa/casa-tiering
- App Defense Alliance, CASA requirements (full list on GitHub): https://appdefensealliance.dev/casa/casa-requirements
- TAC Security, Google CASA plans and prices: https://tacsecurity.com/google-casa-cloud-application-security-assessment/
- Anecdotal timeline and cost (Reddit r/SaaS): https://www.reddit.com/r/SaaS/comments/1q84d0n/i_spent_540_and_1_month_to_get_my_gmail_ai_saas/

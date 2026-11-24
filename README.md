# Shift

A fast Gmail client: Rust core (Tauri 2) with a web UI. Mail is cached in local SQLite, so the UI never waits on the network. Changes come in through Gmail's history API every 30 seconds.

## Setup

1. Google Cloud Console: create a project, enable the **Gmail API**, set up the OAuth consent screen (add your account as a test user), then create an OAuth client of type **Desktop app**.
2. Put the client credentials in `.env.local` (git-ignored) as `GOOGLE_CLIENT_ID=` and `GOOGLE_CLIENT_SECRET=`, then run:

```sh
bun install
bun run tauri dev   # build.rs bakes GOOGLE_CLIENT_ID/SECRET from .env.local into the binary
```



## Demo mode

`bun run demo` opens a fake mailbox in its own database (`demo.sqlite3`), reset on every launch. Nothing talks to Gmail: actions only change the local cache, search is local and Send is a no-op. Use it when working on the UI. Only one of `tauri dev` and `demo` can run at a time (both use port 1420).

## Accounts

Each Google account has its own database in `accounts/<email>.sqlite3` (app data folder) and its own Keychain item for its refresh token. The sidebar switches between **All accounts** (unified; accounts can opt out in Settings → Accounts) and each account. Add accounts from Settings → Accounts, the ⌘K palette, or the first-run screen. The single-account layout (`mail.sqlite3` + one Keychain item) migrates on first launch. Demo mode has two in-memory accounts.

Before public release, see `docs/google-verification.md`.

## Composer

Replies and forwards open inline under the thread; new emails open in a resizable window. The body is a rich-text editor (Tiptap): ⌘B, ⌘I, ⌘U and ⌘K (link) format text, and a small toolbar appears over a selection with lists and quote too. Replies and forwards quote the original as a blockquote, with your signature above it in the editor. Mail goes out as HTML with a plain-text version. Recipients are chips with autocomplete from people you've emailed (`suggest_contacts`). Drafts save to Gmail Drafts about 1.5s after you stop typing, and closing keeps the draft; sending a saved draft uses `drafts.send`, which removes it from Drafts.

## Settings

Open with the gear in the sidebar or `⌘,`. Preferences are saved to `settings.json` in the app data folder; AI provider keys go to the macOS Keychain. Notifications and Scheduling are placeholders until those features exist.

## Keyboard shortcuts

Spark-style single keys and Apple Mail's ⌘ shortcuts both work, and every action can be remapped in Settings → Keyboard shortcuts. The defaults live in `src/keys.ts`.

| Action | Keys |
|---|---|
| New email | `C`, `⌘N` |
| Send (composer) | `⌘↩`, `⇧⌘D` |
| Search | `/`, `⌘F` |
| Check for mail | `⇧⌘N` |
| Next / previous email | `J` `K`, `↓` `↑`, `→` `←` |
| Archive | `E`, `⌃⌘A` |
| Delete | `⌫`, `Delete`, `#` |
| Mark read / unread | `U`, `⇧⌘U` |
| Pin | `D`, `⇧⌘L` |
| Reply | `R`, `⌘R` |
| Reply all | `⇧R`, `A`, `⇧⌘R` |
| Forward | `F`, `⇧⌘F` |
| Label | `L` |
| Move to | `V`, `⇧⌘M` |
| Spam | `!`, `⇧⌘J` |
| Command palette | `⌘K` |
| Settings | `⌘,` |
| Zoom in / out / actual size | `⌘+` `⌘−` `⌘0` |
| Close menu / back | `Esc` |

## Layout

- `src-tauri/src/auth.rs`: OAuth loopback + PKCE; the refresh token lives in the macOS Keychain
- `src-tauri/src/gmail.rs`: Gmail REST client (backoff on 429/5xx)
- `src-tauri/src/db.rs`: SQLite cache (threads, labels, messages)
- `src-tauri/src/lib.rs`: sync loop and Tauri commands
- `src-tauri/src/demo.rs`: demo mailbox fixtures
- `src-tauri/src/settings.rs`: settings file and AI keys in the Keychain
- `src/`: UI (vanilla TypeScript, Phosphor icons); `settings.ts` + `settings-ui.ts` for preferences, `keys.ts` for shortcuts

## Checks

```sh
cd src-tauri && cargo test && cargo clippy --all-targets
bun test        # keyboard shortcut table
bun run build   # tsc + vite
```

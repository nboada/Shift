# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Shift is a Gmail client for macOS: a Rust core (Tauri 2) with a vanilla TypeScript UI. Setup, OAuth credentials, the account layout and the shortcut table are in `README.md`.

## Commands

```sh
bun run demo                      # fake mailbox (SHIFT_DEMO=1), no Gmail; use this for UI work
bun run tauri dev                 # real Gmail; needs GOOGLE_CLIENT_ID/SECRET in .env.local
bun run build                     # tsc + vite (the frontend typecheck)
bun test                          # all TS tests; one file: bun test src/keys.test.ts
cd src-tauri && cargo test        # one test: cargo test label_filtering
cd src-tauri && cargo clippy --all-targets
```

Run all four checks (`bun test`, `bun run build`, `cargo test`, `cargo clippy`) before calling a change done. `tauri dev` and `demo` both need port 1420, so only one can run at a time. `build.rs` bakes the OAuth client in at compile time, so a changed `.env.local` takes a Rust rebuild.

## Architecture

**The local cache comes first.** The UI reads only from SQLite through Tauri commands and never waits on Gmail. Writes such as `modify` change the local DB, emit `mail-changed`, then call Gmail. If the Gmail call fails, the command re-fetches the thread to undo the local change. The frontend listens for `mail-changed` and re-renders (`refresh` in `main.ts`). New commands that change mail should follow the same order.

**Sync** (`lib.rs`): a loop runs `sync` every `general.syncSeconds`, which it reads from the settings file. Accounts sync in parallel. Each syncs incrementally from the `history_id` kept in its `meta` table; a history fetch saves the new `history_id` only after it succeeds, so a failed sync replays instead of skipping changes. With no `history_id`, or when Gmail returns 404 for an expired one, `full_sync` lists the mailbox into a `backfill` queue in `meta` and saves the cursor at once; `backfill` then fetches `BACKFILL_PER_TICK` threads a tick, putting failures at the back. These per-tick limits keep each account under Gmail's per-user quota. Message bodies are prefetched only once the queue is empty. After a history fetch, `notify_new_mail` announces unread Inbox mail newer than the `notified_at` watermark. `mail-changed` is emitted only when something was fetched. Sync failures emit `sync-error`.

**Accounts**: each `Account` in `State` has its own SQLite connection, cached access token and sync lock. Its refresh token lives in the Keychain (`auth.rs`). Commands take `account: String` for one account, or `accounts: Option<Vec<String>>` for a list. `State::scope` turns `None` into the unified view, which leaves out accounts whose `accounts.<email>.unified` setting is `false`. Threads returned to the UI carry their `account`, and the frontend passes it back on every action.

**Demo mode** (`demo.rs`): two in-memory accounts are seeded on each launch with fixtures in Gmail API format, which go through the real parser and `db` code. Every command that reaches the network checks `s.demo` first and returns early or works only on the cache. A new network command needs the same check.

**Settings**: one JSON document. `src/settings.ts` holds `DEFAULTS`, merges the saved file over them, applies changes right away via listeners and dotted paths (`setSetting("appearance.theme", …)`), and saves about 300 ms later through `set_settings`. Rust reads the same file (`settings.rs`) for backend values such as the sync interval and unified-view opt-outs, so a setting the backend uses must have the same key on both sides. AI provider keys go to the Keychain, not the JSON file. `settings-ui.ts` builds the settings window. A section that renders `soon(...)` is a placeholder for a feature that isn't built yet (AI).

**Frontend**: `main.ts` holds the app state as module-level variables (`accounts`, `scope`, `mailbox`, `threads`, `selected`) and renders by setting `innerHTML`. Escape interpolated text with `esc()`. The other files are small modules with their own tests:
- `keys.ts`: the action list and default bindings. Settings can remap every binding.
- `compose.ts`: the editor's extensions, the plain-text version of the body (`docToText`) and the HTML as sent (`emailHtml`). `editor.ts` builds the Tiptap editor and its format bar.
- `attachments.ts`: file chips, icons and sizes for the reader and the composer.
- `recipients.ts`: the recipient chips.
- `palette-match.ts`: ⌘K ranking.

The keyboard handler skips single-key shortcuts while focus is in an `input`, `textarea` or `[contenteditable]`. Any new editable element needs to be covered by that check too. Icons come from Phosphor (`ph-*` classes).

**Composer**: replies and forwards open inline, new emails open in the `#composer` dialog. The body is a Tiptap editor (vanilla core API, StarterKit). Replies and forwards load the original's HTML into a blockquote, which the editor reduces to its own schema. The signature sits in the editor above the quote: a text signature as paragraphs, an HTML one as a `signature` node that shows a sandboxed preview and is swapped for the real HTML by `emailHtml` at save and send time, so signature markup never runs in the app. Drafts and sends carry `html` (from `getHTML`) and `body` (from `docToText`). Files attach with the paperclip or by drag and drop (the window sets `dragDropEnabled: false`, so the webview gets the drop). They travel as base64 in `Draft.attachments`, with a 25 MB total. Forwarding attaches the original's files. Drafts save to Gmail about 1.5 s after typing stops (15 s with over 1 MB of files, since every save re-uploads them). Sending a saved draft uses `drafts.send`. Undo send keeps the email on the Mac until the countdown ends.

**Send later**: Gmail has no scheduled send. `schedule_send` saves the `Draft` JSON (plus opaque `ui` data for reopening the composer) in the per-account `scheduled` table, next to its Gmail draft. `sync` calls `send_due` for every account each tick, in demo mode too, and sends through the same `deliver` as `send`. A 404 drops the row; other errors retry on the next tick. The Scheduled mailbox (`"SCHEDULED"` in `main.ts`) is built from `scheduled` rows, not Gmail threads, so `openThread`, `act` and the list's right-click menu branch on it. Quick times come from `src/schedule.ts`.

**Gmail client** (`gmail.rs`): REST over `reqwest` with backoff on 429/5xx. MIME bodies and attachment details are parsed here. Attachment details go in the `attachments` table, keyed by message. The bytes stay in Gmail and are fetched on demand (`attachment_data`, `open_attachment`), unless Gmail sent them inline. Outgoing mail is built with `mail-builder` (`build_message` in `lib.rs`). Messages over about 3 MB go through Gmail's upload endpoint, because JSON bodies are capped at about 5 MB.

Notes for later work are written in code as `// shortcut: <limit>, <when to upgrade>`. Grep for `shortcut:` to see the known limits.

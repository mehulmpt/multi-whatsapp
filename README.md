# Multi WhatsApp

A Chrome extension (Manifest V3) for using several WhatsApp Web accounts in one browser profile and switching between them quickly.

## Features

- **Switch in one click** from the toolbar popup, or from the in-page switcher tab on the right edge of WhatsApp Web
- **Keyboard shortcuts**
  - `1`–`9` in the popup (or while the in-page switcher is open) jump to that account
  - `Alt+Shift+.` / `Alt+Shift+,` (mac: `Ctrl+Shift+.` / `Ctrl+Shift+,`) go to the next or previous account
  - `Alt+Shift+W` (mac: `Ctrl+Shift+W`) opens the popup
  - You can change these at `chrome://extensions/shortcuts`
- **Rename, recolour, reorder** accounts: double-click or use the ✎ button to edit, and drag to reorder
- The **phone number** of each linked account is detected automatically
- The toolbar badge shows which account is active

## How it works

WhatsApp Web stores its whole session (keys, chats, settings) in IndexedDB and `localStorage` on `https://web.whatsapp.com`. When you switch accounts:

1. The extension sends the WhatsApp tab to `https://web.whatsapp.com/?mwa_op=…`. The content script runs at `document_start` and calls `window.stop()`, so WhatsApp's own code never loads and nothing holds the databases open.
2. It copies the live databases and `localStorage` into a vault inside the same origin (IndexedDB databases named `mwa:<accountId>:<db>`).
3. It clears the live storage, copies the target account's vault back in, and reloads WhatsApp.

All data stays inside WhatsApp's own origin and never leaves your machine. This is required: WhatsApp keeps non-extractable `CryptoKey`s that can only be structured-cloned within the same origin.

A switch is crash-safe. Live storage is cleared only after it has been saved, and the extension records that the live session is "unowned" before clearing it. If a switch is interrupted, retrying never overwrites a good snapshot with an empty one.

**Notes**

- Only one WhatsApp tab is used. Duplicate WhatsApp tabs are closed during a switch, because open tabs would block the database swap.
- Removing an account deletes its saved session in this browser only. To unlink the device completely, also remove it from your phone under *WhatsApp → Linked devices*.
- Clearing site data for web.whatsapp.com deletes every saved account session.
- Each saved account takes about as much disk space as one WhatsApp Web session.

## Development

Requires [Bun](https://bun.sh) ≥ 1.3.

```sh
bun install          # exact versions; bunfig.toml enforces a 7-day minimum release age
bun run build        # → dist/
bun run dev          # watch mode (unminified, inline sourcemaps)
bun run typecheck    # tsc --noEmit
bun run zip          # → release/multi-whatsapp-<version>.zip
```

Load the extension: open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select `dist/`.

### Layout

```
src/
  background/index.ts   service worker: account state, op dispatch, badge, shortcuts
  content/index.ts      entry: switch page (?mwa_op=) or in-page dock
  content/vault.ts      IndexedDB/localStorage snapshot + restore
  content/op-page.ts    the "Switching…" page that runs a vault operation
  content/dock.ts       floating account switcher inside WhatsApp Web
  popup/                toolbar popup UI
  shared/               types + helpers
scripts/
  build.ts              esbuild build, manifest generation, icon rendering
  icons.ts              dependency-free PNG icon renderer
```

# Verification — version 1.0.0

Tested on 2026-11-16 with **Chrome/159.0.8154.6** (Chrome for Testing). The test loaded the actual unpacked `dist/` build into a separate, throwaway browser profile. Run it again with `bun run check`.

## End-to-end (20/20)

- PASS: Manifest V3 extension loads and its service worker starts
- PASS: Fresh install adopts the current session as “Account 1”
- PASS: In-page switcher renders under a strict CSP (no inline styles allowed)
- PASS: Logged-in phone number is detected and shown for the account
- PASS: “Add account” from the popup saves account 1 and opens a fresh, logged-out WhatsApp
- PASS: Switch via the in-page switcher restores account 1 completely
- PASS: Switch via popup number key restores account 2 completely
- PASS: Switch succeeds when WhatsApp's service worker holds the database open
- PASS: Changes made in an account are kept on the next switch
- PASS: Duplicate WhatsApp tabs are closed before a switch
- PASS: Switching with no WhatsApp tab open opens one
- PASS: State survives a service worker restart
- PASS: Interrupted switch (session saved, then crash) never overwrites a saved account
- PASS: Stale switch URLs just load WhatsApp
- PASS: Options page: rename + recolour an account
- PASS: Removing an inactive account deletes its saved session
- PASS: Removing the active account switches to another and discards its session
- PASS: Storage usage + persistence are recorded for the options page
- PASS: Switch page renders under strict CSP
- PASS: No JavaScript errors in WhatsApp, popup or options pages

## Unit (23/23)

- PASS: initials, contrast colour, HTML escaping, byte and time formatting, phone formatting
- PASS: generated icons are valid 16/32/48/128 px RGBA PNGs with transparent rounded corners

## Static checks

- PASS: `tsc --noEmit` (strict, `noUncheckedIndexedAccess`), TypeScript 7.0.2
- PASS: esbuild production build; manifest generated from `package.json`
- PASS: `bun install` with every dependency pinned exactly and `minimumReleaseAge` = 7 days

## Test environment

`web.whatsapp.com` was DNS-mapped (`--host-resolver-rules`) to a local HTTPS server. That server served a fake WhatsApp Web, built to be harder than the real one:

- **Strict CSP:** `style-src 'self'` with no `unsafe-inline`. This proves the switcher and the switch page don't depend on inline styles.
- **Session data:** a non-extractable AES-GCM `CryptoKey`. After every switch the test decrypts a stored secret with it, which proves the key survived and still works.
- **Data shapes:** `Blob` values, out-of-line keys, compound key paths, auto-increment stores, and multi-entry plus regular indexes. Index counts are checked after each restore.
- **Volume:** 3,000 records in one store, so the copy runs in several 500-record chunks. Database versions (5 and 12) must be preserved.
- **localStorage** values, including one changed between switches.
- **Hostile service worker:** it keeps a connection to the session database and ignores `versionchange`. The switch only succeeds because the extension unregisters the worker.

The "interrupted switch" test reproduces the state right after a crash that happens between saving and restoring: the session is saved and the live session has no owner. It checks that the next switch does not save leftover live data over any account.

Switches took 150–400 ms per run for these fixture sessions.

## Not covered by automation

- **The real WhatsApp Web.** Its storage layout and service worker behaviour are inferred, and the fixture was designed to be harder than the real site. Check one real switch between two linked accounts after any major WhatsApp Web update.
- **Global keyboard shortcuts.** Chrome can't trigger `chrome.commands` from automation. They call the same next/previous code path as the tested switches.
- **The real toolbar popup bubble.** The popup was tested as `popup.html` in a tab, which runs the same document and code.

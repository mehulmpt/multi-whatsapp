# Changelog

## 1.1.0

- Faster switching: the save step is incremental. Only records that were added, changed or deleted since the last snapshot are written. On a real account that's a few hundred instead of about 80,000 index-heavy writes.
- Stores copy concurrently and reads overlap with writes. `getAllRecords()` is used where available. Writes use relaxed durability, with one strict commit per database.
- The switch page shows a live record count. The settings page shows how long the last switch took.
- Fix: Retry and Back buttons no longer show while a switch is still running.

## 1.0.0

- Switch between multiple WhatsApp Web accounts from the toolbar popup, an in-page switcher, number keys or global shortcuts
- Add, rename, recolour, reorder and remove accounts; detect phone numbers automatically
- Crash-safe session vault: saves before clearing, never overwrites a saved account after an interrupted switch, retries from the switch page
- Stops WhatsApp's service worker if it blocks a switch; requests persistent storage
- Settings page with switcher options, shortcuts and storage usage
- UI works under a strict page Content-Security-Policy; follows light/dark mode

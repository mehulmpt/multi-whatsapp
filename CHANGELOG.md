# Changelog

## 1.0.0

- Switch between multiple WhatsApp Web accounts from the toolbar popup, an in-page switcher, number keys or global shortcuts
- Add, rename, recolour, reorder and remove accounts; detect phone numbers automatically
- Crash-safe session vault: saves before clearing, never overwrites a saved account after an interrupted switch, retries from the switch page
- Stops WhatsApp's service worker if it blocks a switch; requests persistent storage
- Settings page with switcher options, shortcuts and storage usage
- UI works under a strict page Content-Security-Policy; follows light/dark mode

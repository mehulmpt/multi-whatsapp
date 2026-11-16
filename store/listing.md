# Chrome Web Store listing

Upload `release/multi-whatsapp-<version>.zip` (`bun run zip`). Graphics are in `store/assets/` (`bun run store/capture.ts && bun run store/render.ts` regenerates them; artwork in `store/art/` was made with gpt-image-2.6-sunburst).

## Store listing

**Name** (from manifest): Multi Account for WhatsApp Web

**Summary** (≤132 chars):
> Use several WhatsApp Web accounts in one browser and switch between them in one click — no logging out, no QR codes.

**Category:** Communication · **Language:** English

**Description:**

```
Keep all your WhatsApp numbers in one Chrome profile and switch between them in one click. No logging out, no scanning a QR code every time, no second browser or profile.

HOW IT WORKS
• Link each number once with its QR code, like you normally would.
• Pick an account from the toolbar popup or from the small switcher tab on the right edge of WhatsApp Web.
• The extension saves the current account's session in your browser and loads the one you picked. WhatsApp reloads, already logged in.

FEATURES
• Switch in one click, from the toolbar or inside WhatsApp Web
• Number keys 1–9 jump to an account. Alt+Shift+. and Alt+Shift+, go to the next and previous account (Ctrl on Mac). You can change them in Chrome's shortcut settings.
• Name and colour each account, and drag to reorder
• The phone number of each linked account is detected automatically
• The toolbar badge shows which account is active
• Fast: only changes since the last switch are saved
• Crash-safe: a session is always saved before anything is cleared, and an interrupted switch can be retried without losing data
• Settings page with storage usage, shortcuts and switcher options
• Light and dark mode

PRIVATE BY DESIGN
• Sessions are stored only in your browser, in WhatsApp Web's own storage
• No servers, no accounts, no analytics, no tracking, no remote code
• It never reads your messages. It only swaps sessions.
• Open source: https://github.com/mehulmpt/multi-whatsapp

GOOD TO KNOW
• Only one account is active at a time. Like a closed WhatsApp Web tab, the other accounts don't receive messages in the browser until you switch to them. Your phones still get everything.
• Removing an account deletes its saved session from this browser. To unlink it fully, also remove it on your phone under Linked devices.
• Clearing site data for web.whatsapp.com deletes the saved sessions. You'd need to link each account again.

Multi Account for WhatsApp Web is an independent project. It isn't affiliated with, endorsed by or sponsored by WhatsApp LLC or Meta Platforms, Inc. WhatsApp is a trademark of WhatsApp LLC.
```

**Graphics**
| Field | File |
|---|---|
| Store icon (128×128) | `store/assets/store-icon-128.png` |
| Screenshots (1280×800) | `store/assets/1-switch.jpg` … `5-private.jpg` |
| Small promo tile (440×280) | `store/assets/promo-small.jpg` |
| Marquee promo tile (1400×560) | `store/assets/marquee.jpg` |

**Additional fields**
- Homepage URL: https://github.com/mehulmpt/multi-whatsapp
- Support URL: https://github.com/mehulmpt/multi-whatsapp/issues
- Mature content: No

## Privacy practices

**Single purpose:**
> Lets a user keep several WhatsApp Web accounts in one browser profile and switch between them, by saving and restoring each account's WhatsApp Web session locally in the browser.

**Permission justifications**
- `storage`: Saves the user's list of accounts (name, colour, detected phone number) and their settings locally, so the toolbar popup, in-page switcher and settings page can show and switch accounts.
- `browsingData`: Used only for `https://web.whatsapp.com`, and only to remove its service worker registration. During a switch, WhatsApp's service worker can keep a database open and block the session swap. Removing the worker releases it, and WhatsApp registers it again on its next load. No browsing history or other site data is touched.
- Host permission `https://web.whatsapp.com/*`: The content script runs only on WhatsApp Web. It shows the account switcher and saves and restores the WhatsApp Web session (IndexedDB and localStorage) inside WhatsApp Web's own origin when the user switches accounts.

**Remote code:** No, I am not using remote code. All JavaScript is packaged in the extension. There are no external scripts, eval or WebAssembly.

**Data usage:** None of the categories is collected. The extension stores data only locally on the user's device and transmits nothing to the developer or any third party.

**Certifications** (the publisher must tick these themselves):
- I do not sell or transfer user data to third parties, outside of the approved use cases
- I do not use or transfer user data for purposes that are unrelated to my item's single purpose
- I do not use or transfer user data to determine creditworthiness or for lending purposes

**Privacy policy URL:** https://github.com/mehulmpt/multi-whatsapp/blob/main/PRIVACY.md

## Distribution
- Visibility: Public · Regions: All regions · Pricing: Free

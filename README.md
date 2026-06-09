# Notion Turbo — Long Chat Optimizer

!\[License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
!\[Manifest V3](https://img.shields.io/badge/Manifest-V3-blue.svg)
!\[Browsers](https://img.shields.io/badge/Chrome%20%7C%20Edge%20%7C%20Chromium-supported-success.svg)

> Speed up long Notion AI chats — faster loading and lower CPU/RAM by rendering only your recent messages. Your full history stays safe in Notion.

> \\\*\\\*Not affiliated with, endorsed by, or sponsored by Notion Labs, Inc.\\\*\\\* “Notion” is a trademark of Notion Labs, Inc. This is an independent, community-built extension.

\---

## Overview

Notion Turbo keeps long Notion AI chats fast. As an AI conversation grows, Notion can start to lag — typing stutters, scrolling jumps, memory use climbs, and the chat takes several seconds to open. Notion Turbo fixes this by loading only your most recent exchanges, so even very long threads stay smooth and quick to use.

It's lightweight, opt-in, and safe by design: it never edits, deletes, reorders, or sends your Notion data. **All of your previous messages are still kept on Notion's servers** — the extension simply doesn't render all of them at once in the browser. Turn it off and your full history renders exactly as before.

## Features

* ✅ Speeds up long Notion AI chats by trimming the transcript to your most recent exchanges as the chat loads.
* ✅ Removes the multi-second freeze when opening a very long conversation.
* ✅ Lowers memory and CPU usage by not rendering hundreds of old messages at once.
* ✅ Skips layout and paint for off-screen messages for smoother scrolling.
* ✅ Choose how many recent exchanges to keep — anywhere from **1 to 100**.
* ✅ Always keeps your newest exchange and any in-progress answer fully intact — live responses are never clipped.
* ✅ Remembers your place across reloads, so long chats open fast the next time too.
* ✅ Simple toolbar popup to turn it on/off and adjust settings — no setup required.
* ✅ Optional built-in diagnostic report to help with troubleshooting.

## Install

### From the Chrome Web Store (recommended)

1. Visit the [Chrome Web Store listing](https://chromewebstore.google.com/detail/notion-turbo-%25E2%2580%2594-long-chat/fjkndmidlkigmfdobibghmhlpkpecabe).
2. Click **Add to browser**.

Works on Google Chrome, Microsoft Edge, and other Chromium-based browsers.

### Manual install (load unpacked — for development)

1. Download or clone this repository.
2. Go to `chrome://extensions` (or `edge://extensions`).
3. Enable **Developer mode** (top-right).
4. Click **Load unpacked** and select the extension folder (the one containing `manifest.json`).

## Usage

1. Open any Notion AI chat at `notion.com` or `notion.so`.
2. Click the **Notion Turbo** icon in your browser toolbar.
3. Turn on **“recent exchanges only”** and set how many exchanges to keep.
4. Reload the chat — long threads now load fast and stay responsive.

### Settings

|Setting|What it does|
|-|-|
|**Recent exchanges only**|Master toggle for the trimming/optimization.|
|**Recent exchanges to keep**|How many of your most recent prompt + answer pairs to keep rendered (1–100).|
|**Debug**|Verbose console logging + diagnostic capture. Leave **off** for best performance.|
|**Download diagnostic report**|Saves a JSON report you can attach when filing an issue.|

> Tip: an \\\*\\\*exchange\\\*\\\* = one of your prompts plus its full response. Lower numbers = lighter pages.

## How it works

Notion Turbo runs entirely in your browser. When a long chat loads, it keeps the most recent exchanges and lets the browser skip rendering the older ones, which is what causes the lag on big threads. The newest exchange — and any answer that is still streaming — is always kept fully intact. Nothing is deleted: your complete history remains stored in Notion and reappears whenever you turn the extension off.

## Privacy

No ads, no analytics, no trackers, no cookies. Notion Turbo does not collect, store, or transmit any of your Notion content. The only thing it saves is a small list of message timestamps kept **locally in your own browser**, used to remember which recent exchanges to display. Nothing ever leaves your device.

## Permissions

* **storage** — saves your settings and remembers which recent exchanges to show. This is the only permission requested.

The extension runs only on Notion pages (`notion.com` / `notion.so`) and does nothing on any other site.

## Compatibility

Google Chrome, Microsoft Edge, and other Chromium-based browsers (Manifest V3).

## Support

Found a bug or have a feature request? Please open an issue:
https://github.com/danielvaitekunas/Notion-Turbo/issues

When reporting a performance issue, attaching a **diagnostic report** (popup → Download diagnostic report) helps a lot.

## Contributing

Issues and pull requests are welcome. For larger changes, please open an issue first to discuss what you'd like to change.

## License

[MIT](LICENSE) © 2026 Daniel Vaitekunas

\---

*Not affiliated with, endorsed by, or sponsored by Notion Labs, Inc. “Notion” is a trademark of Notion Labs, Inc.*


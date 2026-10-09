# Bulk Video Transcriber

Drop in a batch of videos and get a separate text transcript for each one.

**Live app:** https://afeefraza.github.io/bulk-video-transcriber/

- Runs 100% in your browser using OpenAI's Whisper model (via [Transformers.js](https://github.com/huggingface/transformers.js)). Your videos are never uploaded anywhere.
- Free. No server, no database, no API key, no account.
- Uses WebGPU for speed (Chrome / Edge); falls back to CPU in other browsers.
- Bulk upload: each file gets its own transcript, with Copy, `.txt` and `.srt` (subtitles) downloads, plus "download all" as a zip.
- Auto language detection, or pick the language yourself.

The model downloads once on first use and is cached by the browser after that.

## Run locally

Any static file server works, for example:

```
npx http-server -p 8080
```

Then open http://localhost:8080.

## Transcribe a whole YouTube channel or Instagram profile

Open the **From a YouTube / Instagram link** tab and paste a channel or profile link (playlists and single video/reel links work too, one per line). The site sends Instagram links to the extension and YouTube links to the helper automatically. Transcription always happens in the browser.

### Instagram: Chrome extension

The extension (in [`extension/`](extension/)) lets the site read Instagram profiles using the login you already have in Chrome. Works in Chrome, Edge and Brave.

1. Download [bulk-transcriber-extension.zip](https://afeefraza.github.io/bulk-video-transcriber/bulk-transcriber-extension.zip) and unzip it.
2. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked** and pick the unzipped folder.
3. Be logged in to instagram.com in that browser, then reload the site.

To protect your account it is read-only (never likes, follows, comments or posts), works through a normal instagram.com tab, waits 4 to 8 seconds between profile pages and 8 to 15 seconds between videos, caps itself at 150 videos and 80 profile pages a day, and stops all Instagram requests for an hour if Instagram signals it wants you to slow down.

### YouTube: local helper

Websites can't download from YouTube on their own, so a small free helper on your PC does that part using [yt-dlp](https://github.com/yt-dlp/yt-dlp).

1. Install [Node.js](https://nodejs.org/) (LTS).
2. In a terminal run:
   ```
   npx -y github:AfeefRaza/bulk-video-transcriber --install
   ```
3. On the site, press **Start helper** (tick "Always allow" the first time). It only runs when you press Start and turns itself off after an hour unused. There's a Stop button too.

To remove the Start button: `npx -y github:AfeefRaza/bulk-video-transcriber --uninstall`

Only download content you have the right to use.

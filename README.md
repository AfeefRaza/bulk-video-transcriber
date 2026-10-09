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

Open the **From a YouTube / Instagram link** tab and paste a channel or profile link (playlists and single video links work too, one per line).

Websites can't download from YouTube or Instagram on their own, so a small free helper on your PC does that part using [yt-dlp](https://github.com/yt-dlp/yt-dlp). Transcription still happens in the browser.

**One-time setup**
1. Install [Node.js](https://nodejs.org/) (LTS).
2. In a terminal run:
   ```
   npx -y github:AfeefRaza/bulk-video-transcriber --install
   ```
3. On the site, press **Start helper** (tick "Always allow" the first time). It only runs when you press Start and turns itself off after an hour unused. There's a Stop button too.

**Instagram:** log in to instagram.com in Firefox once. The helper uses that login on your PC only, read-only. To protect your account it waits between requests like a person browsing, caps Instagram at 150 videos a day, and pauses Instagram for an hour if Instagram signals it wants you to slow down.

To remove the Start button: `npx -y github:AfeefRaza/bulk-video-transcriber --uninstall`

Only download content you have the right to use.

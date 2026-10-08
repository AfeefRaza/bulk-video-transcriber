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

Websites can't download from YouTube or Instagram on their own, so this needs a small free helper running on your computer. It uses [yt-dlp](https://github.com/yt-dlp/yt-dlp), which it downloads automatically. Transcription still happens in the browser.

1. Install [Node.js](https://nodejs.org/) (LTS).
2. In a terminal, run:
   ```
   npx -y github:AfeefRaza/bulk-video-transcriber
   ```
3. Leave it open, go back to the site, and click **Find videos**.

**Instagram:** Instagram only shows profiles to logged-in users. To get every video on a profile, export your instagram.com cookies with the *Get cookies.txt LOCALLY* browser extension, save the file as `cookies.txt` in `~/.bulk-transcriber/` (Windows: `C:\Users\YOU\.bulk-transcriber\`), then restart the helper. Keep that file private.

Only download content you have the right to use.

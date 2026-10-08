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

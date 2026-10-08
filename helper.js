#!/usr/bin/env node
// Local helper for Bulk Video Transcriber.
// Lists every video on a YouTube channel / Instagram profile and streams each
// video's audio to the web app, which transcribes it in the browser.
// Uses yt-dlp (downloaded automatically on first run). No API keys, no server.

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 8787;
const HOME = path.join(os.homedir(), '.bulk-transcriber');
const ALLOWED_ORIGINS = [/^https:\/\/afeefraza\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

const args = process.argv.slice(2);
const browserIdx = args.indexOf('--browser');
const cookiesBrowser = browserIdx >= 0 ? args[browserIdx + 1] : null;

const BIN = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux',
}[process.platform] || 'yt-dlp';
const YTDLP = path.join(HOME, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

function download(url, dest) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'bulk-transcriber' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return download(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      const tmp = dest + '.part';
      const out = fs.createWriteStream(tmp);
      res.pipe(out);
      out.on('finish', () => out.close(() => { fs.renameSync(tmp, dest); resolve(); }));
      out.on('error', reject);
    }).on('error', reject);
  });
}

function run(cmdArgs) {
  return new Promise((resolve) => {
    const p = spawn(YTDLP, cmdArgs, { windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.on('error', (e) => resolve({ code: -1, out: '', err: String(e) }));
  });
}

async function ensureYtDlp() {
  fs.mkdirSync(HOME, { recursive: true });
  if (!fs.existsSync(YTDLP)) {
    console.log('Downloading yt-dlp (first run only)…');
    await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${BIN}`, YTDLP);
    if (process.platform !== 'win32') fs.chmodSync(YTDLP, 0o755);
  } else {
    // YouTube changes often; keep yt-dlp current.
    const u = await run(['-U']);
    const line = (u.out + u.err).trim().split('\n').pop();
    if (line) console.log('yt-dlp:', line);
  }
}

function cookieFile() {
  return [path.join(process.cwd(), 'cookies.txt'), path.join(HOME, 'cookies.txt')].find((f) => fs.existsSync(f));
}

function commonArgs() {
  const a = ['--no-warnings', '--js-runtimes', `node:${process.execPath}`];
  const cf = cookieFile();
  if (cf) a.push('--cookies', cf);
  if (cookiesBrowser) a.push('--cookies-from-browser', cookiesBrowser);
  return a;
}

function checkUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null;
  } catch { return null; }
}

// YouTube channel roots expand to Videos / Shorts / Live tabs.
function channelTabs(u) {
  const x = new URL(u);
  if (!/(^|\.)youtube\.com$/.test(x.hostname)) return null;
  const m = x.pathname.match(/^\/(@[^/]+|channel\/[^/]+|c\/[^/]+|user\/[^/]+)\/?$/);
  if (!m) return null;
  return ['videos', 'shorts', 'streams'].map((t) => `https://www.youtube.com/${m[1]}/${t}`);
}

async function listOne(u) {
  const r = await run([...commonArgs(), '--flat-playlist', '-J', '--', u]);
  if (r.code !== 0) throw new Error(cleanErr(r.err));
  const j = JSON.parse(r.out);
  const entries = j.entries ? flatten(j.entries) : [j];
  return {
    title: j.title || j.uploader || j.channel || '',
    entries: entries.map((e) => ({
      url: e.webpage_url || e.url || (e.id && j.extractor_key === 'Youtube' ? `https://www.youtube.com/watch?v=${e.id}` : e.url),
      title: e.title || e.id || 'Untitled',
      duration: e.duration || null,
    })).filter((e) => e.url),
  };
}

function flatten(list) {
  return list.flatMap((e) => (e && e.entries ? flatten(e.entries) : [e])).filter(Boolean);
}

// ---------- Instagram (yt-dlp's profile lister is broken, so we page the web feed ourselves) ----------
const IG_HEADERS = {
  'x-ig-app-id': '936619743392459',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36',
  Accept: 'application/json',
};

function igUsername(u) {
  const x = new URL(u);
  if (!/(^|\.)instagram\.com$/.test(x.hostname)) return null;
  const m = x.pathname.match(/^\/([A-Za-z0-9._]+)\/?(reels\/?)?$/);
  if (!m || ['p', 'reel', 'reels', 'tv', 'stories', 'explore'].includes(m[1])) return null;
  return m[1];
}

function igCookieHeader() {
  const f = cookieFile();
  if (!f) return '';
  return fs.readFileSync(f, 'utf8').split(/\r?\n/)
    .map((l) => l.replace(/^#HttpOnly_/, ''))
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((c) => c.length >= 7 && c[0].replace(/^\./, '').endsWith('instagram.com'))
    .map((c) => `${c[5]}=${c[6]}`).join('; ');
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error('HTTP ' + res.statusCode), { status: res.statusCode }));
        try { resolve(JSON.parse(s)); } catch { reject(new Error('Instagram sent an unexpected response (are you logged in?)')); }
      });
    }).on('error', reject);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function igList(username) {
  const cookie = igCookieHeader();
  const headers = { ...IG_HEADERS, ...(cookie ? { Cookie: cookie } : {}) };
  const needLogin = 'Instagram only shows profiles to logged-in users. Export your instagram.com cookies to cookies.txt (see the instructions on the website) and restart the helper.';
  let info;
  try {
    info = await getJson(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`, headers);
  } catch (e) {
    if (e.status === 404) throw new Error(`Instagram profile "${username}" not found.`);
    throw new Error(cookie ? `Instagram refused the request (${e.message}). Your cookies may have expired: export a fresh cookies.txt.` : needLogin);
  }
  const user = info.data && info.data.user;
  if (!user) throw new Error(`Instagram profile "${username}" not found.`);
  if (user.is_private && !user.followed_by_viewer) throw new Error('This Instagram profile is private.');

  const entries = [];
  const add = (code, isVideo, caption, duration) => {
    if (isVideo) entries.push({ url: `https://www.instagram.com/p/${code}/`, title: (caption || code).replace(/\s+/g, ' ').slice(0, 90), duration: duration || null });
  };

  if (!cookie) {
    // Logged out: Instagram only exposes the latest 12 posts.
    for (const { node } of user.edge_owner_to_timeline_media.edges) {
      add(node.shortcode, node.is_video, node.edge_media_to_caption.edges[0]?.node.text, node.video_duration);
    }
    return { title: `@${username} (latest posts only; add cookies.txt for all)`, entries };
  }

  let maxId = '';
  for (let page = 0; page < 200; page++) {
    const feed = await getJson(`https://www.instagram.com/api/v1/feed/user/${user.id}/?count=33${maxId ? `&max_id=${maxId}` : ''}`, headers);
    for (const it of feed.items || []) {
      const vid = it.media_type === 2 || (it.carousel_media || []).some((c) => c.media_type === 2);
      add(it.code, vid, it.caption && it.caption.text, it.video_duration);
    }
    if (!feed.more_available || !feed.next_max_id) break;
    maxId = feed.next_max_id;
    await sleep(1200); // be gentle so Instagram doesn't flag the account
  }
  return { title: `@${username}`, entries };
}

async function list(u) {
  const ig = igUsername(u);
  if (ig) return igList(ig);
  const tabs = channelTabs(u);
  if (!tabs) return listOne(u);
  let title = '', entries = [], lastErr;
  for (const t of tabs) {
    try {
      const r = await listOne(t);
      title = title || r.title.replace(/ - (Videos|Shorts|Live)$/, '');
      entries = entries.concat(r.entries);
    } catch (e) { lastErr = e; } // channel may not have every tab
  }
  if (!entries.length && lastErr) throw lastErr;
  const seen = new Set();
  return { title, entries: entries.filter((e) => !seen.has(e.url) && seen.add(e.url)) };
}

function cleanErr(s) {
  const lines = String(s).split('\n').filter((l) => /ERROR/.test(l));
  return (lines.pop() || String(s).trim().split('\n').pop() || 'yt-dlp failed').replace(/^ERROR:\s*/, '');
}

function cors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.some((r) => r.test(o))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    return true;
  }
  return !o; // allow direct (non-browser) requests
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  if (!cors(req, res)) { res.writeHead(403); return res.end(); }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': '*' });
    return res.end();
  }
  const q = new URL(req.url, 'http://x');
  if (q.pathname === '/health') return json(res, 200, { ok: true });

  const target = checkUrl(q.searchParams.get('url') || '');
  if (q.pathname === '/list') {
    if (!target) return json(res, 400, { error: 'Invalid link' });
    console.log('Listing', target);
    try {
      const r = await list(target);
      console.log(`  found ${r.entries.length} videos`);
      return json(res, 200, r);
    } catch (e) {
      console.log('  failed:', e.message);
      return json(res, 500, { error: e.message });
    }
  }

  if (q.pathname === '/audio') {
    if (!target) return json(res, 400, { error: 'Invalid link' });
    console.log('Fetching audio', target);
    const p = spawn(YTDLP, [...commonArgs(), '--no-playlist', '--playlist-items', '1', '-f', 'bestaudio[ext=m4a]/bestaudio/best[ext=mp4]/best', '-o', '-', '--', target], { windowsHide: true });
    let err = '', started = false;
    p.stderr.on('data', (d) => (err += d));
    p.stdout.once('data', () => {
      started = true;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    });
    p.stdout.pipe(res);
    p.on('close', (code) => {
      if (!started) json(res, 500, { error: cleanErr(err) || 'No audio' });
      else if (code !== 0) res.destroy();
    });
    req.on('close', () => { if (!res.writableEnded) p.kill(); });
    return;
  }

  json(res, 404, { error: 'Not found' });
});

ensureYtDlp().then(() => {
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nHelper running on http://127.0.0.1:${PORT}`);
    console.log('Leave this window open, then go back to https://afeefraza.github.io/bulk-video-transcriber/\n');
  });
}).catch((e) => { console.error('Could not set up yt-dlp:', e.message); process.exit(1); });

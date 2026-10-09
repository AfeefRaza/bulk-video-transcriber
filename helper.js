#!/usr/bin/env node
// Local helper for Bulk Video Transcriber.
// Lists every video on a YouTube channel / Instagram profile and streams each
// video's audio to the web app, which transcribes it in the browser.
//
//   npx -y github:AfeefRaza/bulk-video-transcriber --install    one-time: adds the website's "Start helper" button
//   npx -y github:AfeefRaza/bulk-video-transcriber --uninstall  removes it again
//   npx -y github:AfeefRaza/bulk-video-transcriber              run in this window
//
// Instagram uses your own Firefox login (read-only, never posts/likes/follows),
// paced like normal browsing, with a daily cap and an automatic pause if Instagram
// signals it wants us to slow down.

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const PORT = 8787;
const HOME = path.join(os.homedir(), '.bulk-transcriber');
const SITE = 'https://afeefraza.github.io/bulk-video-transcriber/';
const ALLOWED_ORIGINS = [/^https:\/\/afeefraza\.github\.io$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];
const PROTOCOL = 'bulktranscriber';
const IDLE_EXIT_MS = 60 * 60 * 1000;   // background helper turns itself off after 1 hour unused

// Instagram account-safety settings.
const IG = {
  dailyVideoLimit: 150,                 // max Instagram videos downloaded per day
  dailyPageLimit: 60,                   // max profile pages (~33 posts each) listed per day
  pageGapMs: [4000, 8000],              // wait between profile pages
  videoGapMs: [8000, 15000],            // wait between video downloads
  pauseMs: 60 * 60 * 1000,              // stop all Instagram requests for 1h when Instagram pushes back
};
const FIREFOX_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:143.0) Gecko/20100101 Firefox/143.0';

const args = process.argv.slice(2);
const background = args.includes('--background');

if (background) {
  const log = fs.createWriteStream(path.join(HOME, 'helper.log'), { flags: 'a' });
  console.log = (...a) => log.write(new Date().toISOString() + ' ' + a.join(' ') + '\n');
  console.error = console.log;
}
process.removeAllListeners('warning'); // hide node:sqlite "experimental" notice

const BIN = {
  win32: 'yt-dlp.exe',
  darwin: 'yt-dlp_macos',
  linux: process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux',
}[process.platform] || 'yt-dlp';
const YTDLP = path.join(HOME, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');

// ---------- setup ----------
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
  const stamp = path.join(HOME, 'last-update');
  if (!fs.existsSync(YTDLP)) {
    console.log('Downloading yt-dlp (first run only)…');
    await download(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${BIN}`, YTDLP);
    if (process.platform !== 'win32') fs.chmodSync(YTDLP, 0o755);
    fs.writeFileSync(stamp, String(Date.now()));
  } else if (Date.now() - (+readText(stamp) || 0) > 24 * 3600 * 1000) {
    // YouTube changes often; keep yt-dlp current (at most once a day).
    const u = await run(['-U']);
    const line = (u.out + u.err).trim().split('\n').pop();
    if (line) console.log('yt-dlp:', line);
    fs.writeFileSync(stamp, String(Date.now()));
  }
}

function readText(f) { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } }

function install() {
  if (process.platform !== 'win32') {
    console.log('The Start button is Windows-only. On Mac/Linux run: npx -y github:AfeefRaza/bulk-video-transcriber');
    return;
  }
  fs.mkdirSync(HOME, { recursive: true });
  const script = path.join(HOME, 'helper.js');
  fs.copyFileSync(__filename, script);
  const vbs = path.join(HOME, 'start.vbs');
  // Starts the helper with no console window.
  fs.writeFileSync(vbs,
    'Set sh = CreateObject("WScript.Shell")\r\n' +
    `sh.Run """${process.execPath}"" ""${script}"" --background", 0, False\r\n`);
  const key = `HKCU\\Software\\Classes\\${PROTOCOL}`;
  const reg = (a) => execFileSync('reg', a, { stdio: 'ignore' });
  reg(['add', key, '/ve', '/d', 'URL:Bulk Video Transcriber helper', '/f']);
  reg(['add', key, '/v', 'URL Protocol', '/d', '', '/f']);
  reg(['add', `${key}\\shell\\open\\command`, '/ve', '/d', `"${process.env.WINDIR}\\System32\\wscript.exe" "${vbs}"`, '/f']);
  console.log('\nInstalled. Use the "Start helper" button on ' + SITE);
  console.log('It only runs when you click Start, and switches itself off after 1 hour unused.');
  console.log('To remove: npx -y github:AfeefRaza/bulk-video-transcriber --uninstall\n');
}

function uninstall() {
  try { execFileSync('reg', ['delete', `HKCU\\Software\\Classes\\${PROTOCOL}`, '/f'], { stdio: 'ignore' }); } catch {}
  for (const f of ['helper.js', 'start.vbs']) { try { fs.unlinkSync(path.join(HOME, f)); } catch {} }
  console.log('Removed the Start button. (yt-dlp is still in ' + HOME + '; delete that folder to remove everything.)');
}

// ---------- yt-dlp helpers ----------
function checkUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' || x.protocol === 'http:' ? x.toString() : null;
  } catch { return null; }
}

const isInstagram = (u) => /(^|\.)instagram\.com$/.test(new URL(u).hostname);

function ytArgs(u) {
  const a = ['--no-warnings', '--js-runtimes', `node:${process.execPath}`];
  if (isInstagram(u)) {
    const jar = writeIgCookieJar();
    if (jar) a.push('--cookies', jar);
    a.push('--user-agent', FIREFOX_UA);
  }
  return a;
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
  const r = await run([...ytArgs(u), '--flat-playlist', '-J', '--', u]);
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

function cleanErr(s) {
  const lines = String(s).split('\n').filter((l) => /ERROR/.test(l));
  return (lines.pop() || String(s).trim().split('\n').pop() || 'yt-dlp failed').replace(/^ERROR:\s*/, '');
}

// ---------- Firefox login (read-only copy of Firefox's cookie database) ----------
function firefoxProfileDirs() {
  const roots = [];
  if (process.platform === 'win32') {
    roots.push(path.join(process.env.APPDATA || '', 'Mozilla', 'Firefox', 'Profiles'));
    const pk = path.join(process.env.LOCALAPPDATA || '', 'Packages');
    try {
      for (const d of fs.readdirSync(pk)) if (/^Mozilla\.Firefox/i.test(d)) roots.push(path.join(pk, d, 'LocalCache', 'Roaming', 'Mozilla', 'Firefox', 'Profiles'));
    } catch {}
  } else if (process.platform === 'darwin') {
    roots.push(path.join(os.homedir(), 'Library', 'Application Support', 'Firefox', 'Profiles'));
  } else {
    roots.push(path.join(os.homedir(), '.mozilla', 'firefox'), path.join(os.homedir(), 'snap', 'firefox', 'common', '.mozilla', 'firefox'));
  }
  if (process.env.BT_FIREFOX_PROFILES) roots.unshift(process.env.BT_FIREFOX_PROFILES); // for testing
  const dbs = [];
  for (const r of roots) {
    try {
      for (const d of fs.readdirSync(r)) {
        const db = path.join(r, d, 'cookies.sqlite');
        if (fs.existsSync(db)) dbs.push({ db, mtime: fs.statSync(db).mtimeMs });
      }
    } catch {}
  }
  return dbs.sort((a, b) => b.mtime - a.mtime).map((x) => x.db);
}

// Returns [{host,name,value,path,secure,expiry}] for instagram.com from the Firefox profile that has an Instagram login.
function firefoxInstagramCookies() {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { return { state: 'old-node', cookies: [] }; }
  const dbs = firefoxProfileDirs();
  if (!dbs.length) return { state: 'no-firefox', cookies: [] };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bt-ff-'));
  try {
    for (const db of dbs) {
      // Firefox locks its database while open, so read a copy.
      const copy = path.join(tmp, 'c.sqlite');
      fs.copyFileSync(db, copy);
      for (const ext of ['-wal', '-shm']) { try { fs.copyFileSync(db + ext, copy + ext); } catch {} }
      const d = new DatabaseSync(copy, { readOnly: true });
      const rows = d.prepare("SELECT host, name, value, path, isSecure AS secure, expiry FROM moz_cookies WHERE host = 'instagram.com' OR host LIKE '%.instagram.com'").all();
      d.close();
      for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f));
      if (rows.some((r) => r.name === 'sessionid' && r.value)) return { state: 'logged-in', cookies: rows };
    }
    return { state: 'not-logged-in', cookies: [] };
  } catch (e) {
    console.log('Could not read Firefox cookies:', e.message);
    return { state: 'no-firefox', cookies: [] };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}

function igCookies() {
  const ff = firefoxInstagramCookies();
  if (ff.state === 'logged-in') return ff.cookies;
  // Fallback: a cookies.txt exported by hand.
  const f = [path.join(process.cwd(), 'cookies.txt'), path.join(HOME, 'cookies.txt')].find((x) => fs.existsSync(x));
  if (!f) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/)
    .map((l) => l.replace(/^#HttpOnly_/, ''))
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((c) => c.length >= 7 && c[0].replace(/^\./, '').endsWith('instagram.com'))
    .map((c) => ({ host: c[0], path: c[2], secure: c[3] === 'TRUE' ? 1 : 0, expiry: +c[4], name: c[5], value: c[6] }));
}

function writeIgCookieJar() {
  const cookies = igCookies();
  if (!cookies.length) return null;
  const jar = path.join(HOME, 'ig-cookies.txt');
  fs.writeFileSync(jar, '# Netscape HTTP Cookie File\n' + cookies.map((c) => {
    const host = c.host.startsWith('.') ? c.host : '.' + c.host.replace(/^www\./, '');
    let exp = +c.expiry || 0;
    if (exp > 1e11) exp = Math.floor(exp / 1000); // newer Firefox stores milliseconds
    return [host, 'TRUE', c.path || '/', c.secure ? 'TRUE' : 'FALSE', exp, c.name, c.value].join('\t');
  }).join('\n') + '\n', { mode: 0o600 });
  return jar;
}

// ---------- Instagram pacing / safety ----------
const usageFile = path.join(HOME, 'instagram-usage.json');
let igLastAt = 0;
let igPausedUntil = 0;
let igQueue = Promise.resolve();

function usage() {
  const today = new Date().toISOString().slice(0, 10);
  let u = {};
  try { u = JSON.parse(readText(usageFile)); } catch {}
  if (u.date !== today) u = { date: today, videos: 0, pages: 0 };
  return u;
}
function bump(field) { const u = usage(); u[field]++; fs.writeFileSync(usageFile, JSON.stringify(u)); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = ([a, b]) => a + Math.random() * (b - a);

// Serialises every Instagram request and spaces them out like a person browsing.
function igSlot(gap, field) {
  const job = igQueue.then(async () => {
    if (Date.now() < igPausedUntil) {
      throw new Error(`Instagram asked us to slow down, so Instagram is paused until ${new Date(igPausedUntil).toLocaleTimeString()} to protect your account. YouTube still works.`);
    }
    const u = usage();
    const limit = field === 'videos' ? IG.dailyVideoLimit : IG.dailyPageLimit;
    if (u[field] >= limit) {
      throw new Error(`Daily Instagram safety limit reached (${limit} ${field === 'videos' ? 'videos' : 'profile pages'}). It resets tomorrow.`);
    }
    const wait = igLastAt + rand(gap) - Date.now();
    if (wait > 0) await sleep(wait);
    igLastAt = Date.now();
    bump(field);
  });
  igQueue = job.catch(() => {});
  return job;
}
function igDone() { igLastAt = Date.now(); }

function igPushback(msg) {
  igPausedUntil = Date.now() + IG.pauseMs;
  console.log('Instagram pushed back, pausing 1h:', msg);
  return new Error(`Instagram asked us to slow down, so Instagram is paused for 1 hour to protect your account. YouTube still works.`);
}
const PUSHBACK = /429|rate.?limit|please wait|checkpoint|challenge|login_required|feedback_required|spam/i;

// ---------- Instagram profile listing (yt-dlp's profile lister is broken) ----------
function igUsername(u) {
  const x = new URL(u);
  if (!/(^|\.)instagram\.com$/.test(x.hostname)) return null;
  const m = x.pathname.match(/^\/([A-Za-z0-9._]+)\/?(reels\/?)?$/);
  if (!m || ['p', 'reel', 'reels', 'tv', 'stories', 'explore'].includes(m[1])) return null;
  return m[1];
}

function getJson(url, headers) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers }, (res) => {
      let s = '';
      res.on('data', (d) => (s += d));
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(Object.assign(new Error('HTTP ' + res.statusCode + ' ' + s.slice(0, 200)), { status: res.statusCode }));
        try { resolve(JSON.parse(s)); } catch { reject(Object.assign(new Error('login_required'), { status: 401 })); }
      });
    }).on('error', reject);
  });
}

async function igList(username) {
  const cookies = igCookies();
  if (!cookies.length) {
    const st = firefoxInstagramCookies().state;
    throw new Error(st === 'no-firefox'
      ? 'Instagram needs you to be logged in. Install Firefox, log in to instagram.com there, then click Find videos again.'
      : 'Log in to instagram.com in Firefox (keep "stay logged in" on), then click Find videos again.');
  }
  const csrf = (cookies.find((c) => c.name === 'csrftoken') || {}).value || '';
  const headers = {
    'User-Agent': FIREFOX_UA,
    Accept: '*/*',
    'Accept-Language': 'en-US,en;q=0.5',
    'X-IG-App-ID': '936619743392459',
    'X-CSRFToken': csrf,
    'X-Requested-With': 'XMLHttpRequest',
    Referer: `https://www.instagram.com/${username}/`,
    Cookie: cookies.map((c) => `${c.name}=${c.value}`).join('; '),
  };
  const ig = async (url) => {
    await igSlot(IG.pageGapMs, 'pages');
    try { return await getJson(url, headers); }
    catch (e) {
      if (e.status === 404) throw new Error(`Instagram profile "${username}" not found.`);
      if (e.status === 401 || e.status === 403) throw new Error('Your Firefox Instagram login has expired. Log in to instagram.com in Firefox again.');
      if (PUSHBACK.test(e.message)) throw igPushback(e.message);
      throw e;
    } finally { igDone(); }
  };

  const info = await ig(`https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`);
  const user = info.data && info.data.user;
  if (!user) throw new Error(`Instagram profile "${username}" not found.`);
  if (user.is_private && !user.followed_by_viewer) throw new Error('This Instagram profile is private.');

  const entries = [];
  let maxId = '', note = '';
  for (;;) {
    let feed;
    try {
      feed = await ig(`https://www.instagram.com/api/v1/feed/user/${user.id}/?count=33${maxId ? `&max_id=${maxId}` : ''}`);
    } catch (e) {
      if (!entries.length) throw e;
      note = ` (stopped early: ${e.message})`;
      break;
    }
    for (const it of feed.items || []) {
      const vid = it.media_type === 2 || (it.carousel_media || []).some((c) => c.media_type === 2);
      if (vid) entries.push({
        url: `https://www.instagram.com/p/${it.code}/`,
        title: ((it.caption && it.caption.text) || it.code).replace(/\s+/g, ' ').slice(0, 90),
        duration: it.video_duration || null,
      });
    }
    if (!feed.more_available || !feed.next_max_id) break;
    maxId = feed.next_max_id;
  }
  return { title: `@${username}${note}`, entries };
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

// ---------- HTTP server ----------
function cors(req, res) {
  const o = req.headers.origin;
  if (o && ALLOWED_ORIGINS.some((r) => r.test(o))) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    return true;
  }
  return !o;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

let idleTimer;
function touch() {
  if (!background) return;
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { console.log('Idle for 1 hour, exiting.'); process.exit(0); }, IDLE_EXIT_MS);
}

const server = http.createServer(async (req, res) => {
  if (!cors(req, res)) { res.writeHead(403); return res.end(); }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'X-Transcriber' });
    return res.end();
  }
  const q = new URL(req.url, 'http://x');
  if (q.pathname === '/health') {
    const u = usage();
    return json(res, 200, {
      ok: true, background,
      instagram: firefoxInstagramCookies().state,
      igVideosToday: u.videos, igVideoLimit: IG.dailyVideoLimit,
      igPausedUntil: igPausedUntil > Date.now() ? igPausedUntil : null,
    });
  }
  // Everything else needs a custom header, which only allowed sites can send (blocks drive-by requests).
  if (req.headers['x-transcriber'] !== '1') return json(res, 403, { error: 'Forbidden' });
  touch();

  if (q.pathname === '/stop') {
    json(res, 200, { ok: true });
    console.log('Stopped from the website.');
    return setTimeout(() => process.exit(0), 100);
  }

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
    const ig = isInstagram(target);
    if (ig) {
      try { await igSlot(IG.videoGapMs, 'videos'); } catch (e) { return json(res, 429, { error: e.message }); }
      if (req.destroyed) { igDone(); return; }
    }
    console.log('Fetching audio', target);
    const p = spawn(YTDLP, [...ytArgs(target), '--no-playlist', '--playlist-items', '1', '-f', 'bestaudio[ext=m4a]/bestaudio/best[ext=mp4]/best', '-o', '-', '--', target], { windowsHide: true });
    let err = '', started = false;
    p.stderr.on('data', (d) => (err += d));
    p.stdout.once('data', () => {
      started = true;
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    });
    p.stdout.pipe(res);
    p.on('close', (code) => {
      if (ig) igDone();
      if (!started) {
        let msg = cleanErr(err) || 'No audio';
        if (ig && PUSHBACK.test(err)) msg = igPushback(err).message;
        json(res, 500, { error: msg });
      } else if (code !== 0) res.destroy();
    });
    req.on('close', () => { if (!res.writableEnded) p.kill(); });
    return;
  }

  json(res, 404, { error: 'Not found' });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log('Helper is already running.'); process.exit(0); }
  throw e;
});

async function main() {
  if (args.includes('--uninstall')) return uninstall();
  if (args.includes('--install')) install();
  await ensureYtDlp();
  server.listen(PORT, '127.0.0.1', () => {
    touch();
    console.log(`Helper running on http://127.0.0.1:${PORT}` + (background ? ' (background)' : ''));
    if (!background) console.log(`Leave this window open and use ${SITE}\n`);
  });
}

main().catch((e) => { console.error('Helper failed to start:', e.message); process.exit(1); });

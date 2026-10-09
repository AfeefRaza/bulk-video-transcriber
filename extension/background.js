// Instagram side of Bulk Video Transcriber.
// Every Instagram API call runs inside an instagram.com tab, exactly like the site itself does,
// using your normal Chrome login. Read-only: it never likes, follows, comments, posts or messages.

const SITE = 'https://afeefraza.github.io/bulk-video-transcriber/';
const APP_ID = '936619743392459';

// Account-safety settings.
const IG = {
  dailyVideoLimit: 150,          // max videos downloaded per day
  dailyPageLimit: 80,            // max Instagram API calls (profile pages / post lookups) per day
  pageGapMs: [4000, 8000],       // wait between API calls
  videoGapMs: [8000, 15000],     // wait between video downloads
  pauseMs: 60 * 60 * 1000,       // stop everything for 1h if Instagram pushes back
};
const PUSHBACK = /checkpoint|challenge_required|feedback_required|please wait a few minutes|rate.?limit|spam/i;
const CHUNK = 1 << 20;

chrome.action.onClicked.addListener(() => chrome.tabs.create({ url: SITE }));

// ---------- pure helpers ----------
function parseIgUrl(u) {
  let x;
  try { x = new URL(u); } catch { return null; }
  if (!/(^|\.)instagram\.com$/.test(x.hostname)) return null;
  const post = x.pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
  if (post) return { kind: 'post', code: post[1] };
  const user = x.pathname.match(/^\/([A-Za-z0-9._]+)\/?(?:reels\/?|tagged\/?)?$/);
  if (user && !['explore', 'stories', 'accounts', 'direct'].includes(user[1])) return { kind: 'user', username: user[1] };
  return null;
}

function codeToPk(code) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  let n = 0n;
  for (const ch of code.slice(0, 11)) n = n * 64n + BigInt(A.indexOf(ch));
  return n.toString();
}

function decodeEntities(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// Picks the audio-only track (small) and the full video (fallback) for a post, if it has a video.
function mediaOf(item) {
  const m = item.media_type === 8 ? (item.carousel_media || []).find((c) => c.media_type === 2) : item;
  if (!m || m.media_type !== 2) return null;
  let audio = null;
  const dash = m.video_dash_manifest || '';
  for (const set of dash.match(/<AdaptationSet[\s\S]*?<\/AdaptationSet>/g) || []) {
    if (/contentType="audio"|mimeType="audio/.test(set)) {
      const b = set.match(/<BaseURL>([^<]+)<\/BaseURL>/);
      if (b) { audio = decodeEntities(b[1]); break; }
    }
  }
  const video = (m.video_versions && m.video_versions[0] && m.video_versions[0].url) || null;
  return video || audio ? { audio, video, duration: m.video_duration || item.video_duration || null } : null;
}

function entryOf(item) {
  const media = mediaOf(item);
  if (!media) return null;
  return {
    url: `https://www.instagram.com/p/${item.code}/`,
    code: item.code,
    title: ((item.caption && item.caption.text) || item.code).replace(/\s+/g, ' ').slice(0, 90),
    duration: media.duration,
    media,
  };
}

// ---------- safety: pacing, daily caps, pause ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rand = ([a, b]) => a + Math.random() * (b - a);
const today = () => new Date().toISOString().slice(0, 10);

async function state() {
  const s = await chrome.storage.local.get({ usage: null, pausedUntil: 0, lastAt: 0 });
  if (!s.usage || s.usage.date !== today()) s.usage = { date: today(), videos: 0, pages: 0 };
  return s;
}

let queue = Promise.resolve();
// Runs Instagram requests one at a time, spaced out like a person browsing.
function slot(kind) {
  const job = queue.then(async () => {
    const s = await state();
    if (Date.now() < s.pausedUntil) {
      throw new Error(`Instagram asked us to slow down, so Instagram is paused until ${new Date(s.pausedUntil).toLocaleTimeString()} to protect your account.`);
    }
    const isVideo = kind === 'video';
    const limit = isVideo ? IG.dailyVideoLimit : IG.dailyPageLimit;
    if (s.usage[isVideo ? 'videos' : 'pages'] >= limit) {
      throw new Error(`Daily Instagram safety limit reached (${limit} ${isVideo ? 'videos' : 'requests'}). It resets tomorrow.`);
    }
    const wait = s.lastAt + rand(isVideo ? IG.videoGapMs : IG.pageGapMs) - Date.now();
    if (wait > 0) await sleep(wait);
    s.usage[isVideo ? 'videos' : 'pages']++;
    await chrome.storage.local.set({ usage: s.usage, lastAt: Date.now() });
  });
  queue = job.catch(() => {});
  return job;
}

async function pause(reason) {
  await chrome.storage.local.set({ pausedUntil: Date.now() + IG.pauseMs });
  console.warn('Instagram pushed back, pausing 1h:', reason);
  return new Error('Instagram asked us to slow down, so Instagram is paused for 1 hour to protect your account.');
}

// ---------- the instagram.com tab we work through ----------
let ownTab = null;
let closeTimer = null;

async function igTab() {
  clearTimeout(closeTimer);
  const tabs = await chrome.tabs.query({ url: 'https://www.instagram.com/*' });
  let tab = tabs.find((t) => t.status === 'complete') || tabs[0];
  if (!tab) {
    tab = await chrome.tabs.create({ url: 'https://www.instagram.com/', active: false });
    ownTab = tab.id;
  }
  for (let i = 0; i < 60 && tab.status !== 'complete'; i++) {
    await sleep(500);
    tab = await chrome.tabs.get(tab.id);
  }
  return tab.id;
}

function scheduleClose() {
  clearTimeout(closeTimer);
  if (ownTab == null) return;
  closeTimer = setTimeout(() => { chrome.tabs.remove(ownTab).catch(() => {}); ownTab = null; }, 2 * 60 * 1000);
}

// Runs inside instagram.com: a normal same-site request with the user's own session.
async function inPageFetch(url, appId) {
  if (!/(^|; )ds_user_id=/.test(document.cookie)) return { login: false };
  const csrf = (document.cookie.match(/(?:^|; )csrftoken=([^;]+)/) || [])[1] || '';
  try {
    const r = await fetch(url, {
      credentials: 'include',
      headers: { 'X-IG-App-ID': appId, 'X-CSRFToken': csrf, 'X-Requested-With': 'XMLHttpRequest' },
    });
    return { login: true, status: r.status, text: await r.text() };
  } catch (e) {
    return { login: true, status: 0, text: String(e) };
  }
}

async function igApi(path) {
  await slot('page');
  const tabId = await igTab();
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId }, func: inPageFetch, args: ['https://www.instagram.com' + path, APP_ID],
  });
  scheduleClose();
  if (!result || !result.login) throw new Error('Log in to instagram.com in this Chrome first, then try again.');
  if (result.status === 429 || PUSHBACK.test(result.text)) throw await pause(`HTTP ${result.status}`);
  if (result.status === 404) throw Object.assign(new Error('Not found on Instagram.'), { notFound: true });
  if (result.status === 401 || result.status === 403 || /login_required/.test(result.text)) {
    throw new Error('Your Instagram login in Chrome has expired. Log in to instagram.com again.');
  }
  if (result.status !== 200) throw new Error(`Instagram error (HTTP ${result.status}).`);
  try { return JSON.parse(result.text); } catch { throw new Error('Instagram sent an unexpected response. Try again later.'); }
}

// ---------- listing ----------
async function listProfile(username, progress) {
  let info;
  try { info = await igApi(`/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`); }
  catch (e) { if (e.notFound) throw new Error(`Instagram profile "${username}" not found.`); throw e; }
  const user = info.data && info.data.user;
  if (!user) throw new Error(`Instagram profile "${username}" not found.`);
  if (user.is_private && !user.followed_by_viewer) throw new Error('This Instagram profile is private.');

  const entries = [];
  let maxId = '', note = '';
  for (;;) {
    let feed;
    try {
      feed = await igApi(`/api/v1/feed/user/${user.id}/?count=33${maxId ? `&max_id=${encodeURIComponent(maxId)}` : ''}`);
    } catch (e) {
      if (!entries.length) throw e;
      note = ` (stopped early: ${e.message})`;
      break;
    }
    for (const it of feed.items || []) { const en = entryOf(it); if (en) entries.push(en); }
    progress(`Found ${entries.length} videos so far on @${username} (going slowly to protect your account)…`);
    if (!feed.more_available || !feed.next_max_id) break;
    maxId = feed.next_max_id;
  }
  await cache(entries);
  return { title: `@${username}${note}`, entries: entries.map(({ media, ...e }) => e) };
}

async function listPost(code) {
  let info;
  try { info = await igApi(`/api/v1/media/${codeToPk(code)}/info/`); }
  catch (e) { if (e.notFound) throw new Error('That Instagram post was not found.'); throw e; }
  const en = info.items && info.items[0] && entryOf(info.items[0]);
  if (!en) throw new Error('That Instagram post has no video.');
  await cache([en]);
  return { title: '', entries: [{ url: en.url, code: en.code, title: en.title, duration: en.duration }] };
}

// Media links are signed and expire after a while, so keep them for a few hours only.
async function cache(entries) {
  const now = Date.now();
  const obj = {};
  for (const e of entries) obj['m:' + e.code] = { media: e.media, at: now };
  await chrome.storage.session.set(obj);
}

async function mediaFor(code) {
  const k = 'm:' + code;
  const c = (await chrome.storage.session.get(k))[k];
  if (c && Date.now() - c.at < 3 * 3600 * 1000) return c.media;
  const info = await igApi(`/api/v1/media/${codeToPk(code)}/info/`);
  const en = info.items && info.items[0] && entryOf(info.items[0]);
  if (!en) throw new Error('This post has no video.');
  await cache([en]);
  return en.media;
}

// ---------- download ----------
async function sendAudio(port, code, forceVideo) {
  const media = await mediaFor(code);
  await slot('video');
  const url = (!forceVideo && media.audio) || media.video || media.audio;
  const r = await fetch(url);
  if (r.status === 403 || r.status === 410) {
    await chrome.storage.session.remove('m:' + code); // link expired
    throw new Error('Video link expired. Click Find videos again.');
  }
  if (!r.ok) throw new Error(`Download failed (HTTP ${r.status}).`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  for (let o = 0; o < bytes.length; o += CHUNK) {
    const part = bytes.subarray(o, o + CHUNK);
    let s = '';
    for (let i = 0; i < part.length; i += 0x8000) s += String.fromCharCode.apply(null, part.subarray(i, i + 0x8000));
    port.postMessage({ kind: 'chunk', b64: btoa(s) });
  }
  port.postMessage({ kind: 'done', meta: { audioOnly: url === media.audio } });
}

// ---------- messages from the website ----------
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'bt') return;
  const send = (m) => { try { port.postMessage(m); } catch {} };
  port.onMessage.addListener(async ({ type, payload }) => {
    try {
      if (type === 'status') {
        const s = await state();
        return send({ kind: 'result', data: {
          videosToday: s.usage.videos, videoLimit: IG.dailyVideoLimit,
          pausedUntil: s.pausedUntil > Date.now() ? s.pausedUntil : null,
        } });
      }
      if (type === 'list') {
        const p = parseIgUrl(payload.url);
        if (!p) throw new Error('That is not an Instagram profile or post link.');
        const progress = (text) => send({ kind: 'progress', text });
        const data = p.kind === 'user' ? await listProfile(p.username, progress) : await listPost(p.code);
        return send({ kind: 'result', data });
      }
      if (type === 'audio') {
        const p = parseIgUrl(payload.url);
        if (!p || p.kind !== 'post') throw new Error('Not an Instagram post link.');
        return await sendAudio(port, p.code, payload.forceVideo);
      }
      throw new Error('Unknown request');
    } catch (e) {
      send({ kind: 'error', error: e.message || String(e) });
    }
  });
});

if (typeof module !== 'undefined') module.exports = { parseIgUrl, codeToPk, mediaOf, entryOf };

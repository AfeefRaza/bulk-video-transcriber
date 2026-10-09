const $ = (id) => document.getElementById(id);
const worker = new Worker('worker.js', { type: 'module' });

const HELPER = 'http://127.0.0.1:8787';
const jobs = [];          // { id, file | url+title, status, text, chunks, el, secs }
let nextId = 1;
let running = false;
let modelReady = false;
const pendingResolvers = new Map();

// ---------- worker messages ----------
const loadFiles = new Map();
worker.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'load-progress') {
    const p = m.data;
    if (p.status === 'progress' && p.total) {
      loadFiles.set(p.file, { loaded: p.loaded, total: p.total });
      let l = 0, t = 0;
      loadFiles.forEach((v) => { l += v.loaded; t += v.total; });
      setStatus(`Downloading model (first time only)… ${(l / 1e6).toFixed(0)} / ${(t / 1e6).toFixed(0)} MB`, l / t);
    } else if (p.status === 'ready') {
      setStatus('Loading model into memory…', 1);
    }
  } else if (m.type === 'ready') {
    modelReady = true;
    setStatus(`Model ready (${m.gpu ? 'WebGPU, fast mode' : 'CPU mode'}).`, 0);
    pendingResolvers.get('load')?.();
  } else if (m.type === 'result' || m.type === 'error') {
    pendingResolvers.get(m.id)?.(m);
  }
};

function call(msg, key) {
  return new Promise((res) => { pendingResolvers.set(key, (v) => { pendingResolvers.delete(key); res(v); }); worker.postMessage(msg); });
}

function setStatus(text, frac) {
  $('status').textContent = text;
  $('barFill').style.width = frac == null ? '0' : Math.round(frac * 100) + '%';
}

// ---------- audio extraction ----------
async function fetchAudio(url) {
  let r;
  try { r = await helperFetch(`/audio?url=${encodeURIComponent(url)}`); }
  catch { throw new Error("Can't reach the helper. Press Start helper (Download from a link tab) and try again."); }
  if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(j.error || 'Download failed'); }
  return r.arrayBuffer();
}

async function decodeAudio(buf) {
  const ctx = new AudioContext({ sampleRate: 16000 });
  try {
    const audio = await ctx.decodeAudioData(buf);
    if (audio.numberOfChannels === 1) return audio.getChannelData(0);
    const out = new Float32Array(audio.length);
    for (let c = 0; c < audio.numberOfChannels; c++) {
      const d = audio.getChannelData(c);
      for (let i = 0; i < d.length; i++) out[i] += d[i];
    }
    for (let i = 0; i < out.length; i++) out[i] /= audio.numberOfChannels;
    return out;
  } finally { ctx.close(); }
}

// ---------- UI ----------
function addFiles(files) {
  for (const file of files) {
    if (!/^(video|audio)\//.test(file.type) && !/\.(mp4|mkv|mov|webm|avi|m4v|mp3|wav|m4a|aac|ogg|flac|opus)$/i.test(file.name)) continue;
    const job = { id: nextId++, file, status: 'queued', text: '', chunks: [] };
    job.el = renderCard(job);
    $('list').appendChild(job.el);
    jobs.push(job);
  }
  updateSummary();
  run();
}

function renderCard(job) {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `<header><div class="name"></div><span class="badge"></span>
    <div class="actions" hidden><button data-a="copy">Copy</button><button data-a="txt">.txt</button><button data-a="srt">.srt</button></div></header>`;
  if (job.url) {
    const a = document.createElement('a');
    a.href = job.url; a.target = '_blank'; a.rel = 'noopener'; a.textContent = job.title;
    el.querySelector('.name').appendChild(a);
  } else el.querySelector('.name').textContent = job.file.name;
  el.querySelector('.actions').addEventListener('click', (e) => {
    const a = e.target.dataset.a; if (!a) return;
    if (a === 'copy') { navigator.clipboard.writeText(job.text); e.target.textContent = 'Copied'; setTimeout(() => e.target.textContent = 'Copy', 1200); }
    if (a === 'txt') download(baseName(job) + '.txt', transcriptText(job));
    if (a === 'srt') download(baseName(job) + '.srt', toSrt(job.chunks));
  });
  updateCard(job, el);
  return el;
}

function updateCard(job, el = job.el) {
  const b = el.querySelector('.badge');
  b.className = 'badge ' + job.status;
  b.innerHTML = {
    queued: 'Waiting',
    decoding: `<span class="spin"></span>${job.url ? 'Downloading audio' : 'Extracting audio'}`,
    working: '<span class="spin"></span>Transcribing',
    done: `Done in ${job.secs}s`,
    error: 'Failed',
  }[job.status];
  el.querySelector('.actions').hidden = job.status !== 'done';
  let pre = el.querySelector('pre');
  if (job.status === 'done' || job.status === 'error') {
    if (!pre) { pre = document.createElement('pre'); el.appendChild(pre); }
    const ts = $('showTs').checked && job.status === 'done';
    pre.className = ts ? 'ts' : '';
    pre.textContent = job.status === 'error' ? job.text : (ts ? timestamped(job.chunks) : job.text || '(No speech detected)');
  }
}

function updateSummary() {
  $('toolbar').hidden = jobs.length === 0;
  const done = jobs.filter((j) => j.status === 'done').length;
  const failed = jobs.filter((j) => j.status === 'error').length;
  $('summary').textContent = `${done} of ${jobs.length} done` + (failed ? `, ${failed} failed` : '');
  $('zipTxt').disabled = $('zipSrt').disabled = done === 0;
}

// ---------- queue ----------
async function run() {
  if (running) return;
  running = true;
  const model = $('model').value;
  if (!modelReady) {
    setStatus('Preparing model…', 0);
    await call({ type: 'load', model }, 'load');
  }
  let job;
  while ((job = jobs.find((j) => j.status === 'queued'))) {
    const t0 = performance.now();
    job.status = 'decoding'; updateCard(job);
    let audio, buf;
    try {
      if (job.url) setStatus(`Downloading audio for ${job.title}…`, null);
      buf = job.url ? await fetchAudio(job.url) : await job.file.arrayBuffer();
      audio = await decodeAudio(buf);
    } catch (err) {
      job.status = 'error';
      job.text = !buf ? "Couldn't download this video: " + err.message
        : "Couldn't read the audio track. The file may have no sound or use a codec this browser can't decode (try MP4 or WebM).";
      updateCard(job); updateSummary(); continue;
    }
    buf = null;
    job.status = 'working'; updateCard(job);
    setStatus(`Transcribing ${job.url ? job.title : job.file.name} (${fmtDur(audio.length / 16000)} of audio)…`, null);
    const r = await call({ type: 'transcribe', id: job.id, audio, model: $('model').value, language: $('language').value }, job.id);
    job.secs = ((performance.now() - t0) / 1000).toFixed(1);
    if (r.type === 'error') { job.status = 'error'; job.text = 'Transcription failed: ' + r.message; }
    else { job.status = 'done'; job.text = r.text; job.chunks = r.chunks; }
    updateCard(job); updateSummary();
  }
  const done = jobs.filter((j) => j.status === 'done').length;
  setStatus(`All finished. ${done} of ${jobs.length} transcribed.`, 1);
  running = false;
}

// ---------- formatting ----------
function pad(n, w = 2) { return String(n).padStart(w, '0'); }
function fmtDur(s) { s = Math.round(s); return s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : `${Math.floor(s / 60)}m ${s % 60}s`; }
function srtTime(s) { const ms = Math.round(s * 1000); return `${pad(Math.floor(ms / 3600000))}:${pad(Math.floor(ms / 60000) % 60)}:${pad(Math.floor(ms / 1000) % 60)},${pad(ms % 1000, 3)}`; }
function shortTime(s) { s = Math.floor(s); return s >= 3600 ? `${Math.floor(s / 3600)}:${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}` : `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; }
function chunkTimes(chunks, i) {
  const [s, e] = chunks[i].timestamp;
  const end = e ?? chunks[i + 1]?.timestamp[0] ?? s + 3;
  return [s ?? 0, Math.max(end, (s ?? 0) + 0.5)];
}
function timestamped(chunks) { return chunks.map((c, i) => `[${shortTime(chunkTimes(chunks, i)[0])}] ${c.text.trim()}`).join('\n'); }
function toSrt(chunks) {
  return chunks.map((c, i) => { const [s, e] = chunkTimes(chunks, i); return `${i + 1}\n${srtTime(s)} --> ${srtTime(e)}\n${c.text.trim()}\n`; }).join('\n');
}
function transcriptText(job) { return $('showTs').checked ? timestamped(job.chunks) : job.text; }
function baseName(job) {
  if (job.file) return job.file.name.replace(/\.[^.]+$/, '');
  return job.title.replace(/[\\/:*?"<>|#\s]+/g, ' ').trim().slice(0, 80) || 'video';
}
function download(name, text) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
async function zipAll(kind) {
  const zip = new JSZip();
  const used = new Set();
  for (const j of jobs.filter((j) => j.status === 'done')) {
    let n = baseName(j), k = 2;
    while (used.has(n)) n = `${baseName(j)} (${k++})`;
    used.add(n);
    zip.file(`${n}.${kind}`, kind === 'srt' ? toSrt(j.chunks) : transcriptText(j));
  }
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob); a.download = `transcripts-${kind}.zip`; a.click();
}

// ---------- events ----------
const drop = $('drop');
drop.addEventListener('click', () => $('file').click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('file').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
$('model').addEventListener('change', () => { modelReady = false; loadFiles.clear(); });
$('showTs').addEventListener('change', () => jobs.forEach((j) => updateCard(j)));
$('zipTxt').addEventListener('click', () => zipAll('txt'));
$('zipSrt').addEventListener('click', () => zipAll('srt'));
$('clear').addEventListener('click', () => {
  for (let i = jobs.length - 1; i >= 0; i--) if (jobs[i].status === 'done' || jobs[i].status === 'error') { jobs[i].el.remove(); jobs.splice(i, 1); }
  updateSummary();
});

// ---------- from a link ----------
document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => {
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('active', x === t));
  $('tab-files').hidden = t.dataset.tab !== 'files';
  $('tab-link').hidden = t.dataset.tab !== 'link';
}));

let found = [];
$('copyCmd').addEventListener('click', (e) => {
  navigator.clipboard.writeText($('cmdText').textContent);
  e.target.textContent = 'Copied'; setTimeout(() => (e.target.textContent = 'Copy'), 1200);
});

function helperFetch(p) { return fetch(HELPER + p, { headers: { 'X-Transcriber': '1' } }); }

let helperInfo = null;
async function helperUp() {
  try {
    const r = await fetch(HELPER + '/health');
    helperInfo = r.ok ? await r.json() : null;
  } catch { helperInfo = null; }
  renderHelper();
  return !!helperInfo;
}

const IG_STATE = {
  'logged-in': 'Instagram: using your Firefox login.',
  'not-logged-in': 'Instagram: Firefox found, but you are not logged in to instagram.com there. YouTube works without it.',
  'no-firefox': 'Instagram: needs Firefox with instagram.com logged in. YouTube works without it.',
  'old-node': 'Instagram: please update Node.js to the latest LTS to use your Firefox login.',
};
function renderHelper() {
  const on = !!helperInfo;
  $('hDot').className = 'dot ' + (on ? 'on' : 'off');
  $('hText').textContent = on ? 'Helper is running.' : 'Helper is off.';
  $('startBtn').hidden = on;
  $('stopBtn').hidden = !on;
  $('igState').hidden = !on;
  if (on) {
    let s = IG_STATE[helperInfo.instagram] || '';
    if (helperInfo.instagram === 'logged-in') s += ` ${helperInfo.igVideosToday} of ${helperInfo.igVideoLimit} daily Instagram videos used.`;
    if (helperInfo.igPausedUntil) s += ` Paused for safety until ${new Date(helperInfo.igPausedUntil).toLocaleTimeString()}.`;
    $('igState').textContent = s;
    $('setup').hidden = true;
  }
}

// Poll while the link tab is open so the status stays current.
let pollTimer;
function startPolling() {
  clearInterval(pollTimer);
  helperUp();
  pollTimer = setInterval(() => { if (!$('tab-link').hidden) helperUp(); }, 4000);
}
document.querySelector('[data-tab=link]').addEventListener('click', startPolling);

$('startBtn').addEventListener('click', () => {
  $('hText').innerHTML = '<span class="spin"></span>Starting helper…';
  let tries = 0;
  const t = setInterval(async () => {
    tries++;
    if (await helperUp()) clearInterval(t);
    else if (tries > 20) {
      clearInterval(t);
      $('hText').textContent = "Helper didn't start. Do the one-time setup below first.";
      $('setup').hidden = false;
    } else $('hText').innerHTML = '<span class="spin"></span>Starting helper…';
  }, 1500);
});
$('stopBtn').addEventListener('click', async () => {
  try { await helperFetch('/stop'); } catch {}
  setTimeout(helperUp, 500);
});

$('findBtn').addEventListener('click', async () => {
  const links = $('links').value.split(/\s+/).filter((s) => /^https?:\/\//i.test(s));
  if (!links.length) { $('helperState').textContent = 'Paste a link that starts with https://'; return; }
  $('findBtn').disabled = true;
  $('helperState').innerHTML = '<span class="spin"></span>Connecting to helper…';
  if (!(await helperUp())) {
    $('setup').hidden = false;
    $('helperState').textContent = 'Press Start helper first (first time? do the setup below).';
    $('findBtn').disabled = false;
    return;
  }
  $('setup').hidden = true;
  found = [];
  const titles = [], errors = [];
  for (const link of links) {
    $('helperState').innerHTML = '<span class="spin"></span>Finding videos (big channels can take a minute)…';
    try {
      const r = await helperFetch(`/list?url=${encodeURIComponent(link)}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      found.push(...j.entries);
      if (j.title) titles.push(j.title);
    } catch (e) { errors.push(`${link}: ${e.message}`); }
  }
  const seen = new Set();
  found = found.filter((v) => !seen.has(v.url) && seen.add(v.url));
  $('findBtn').disabled = false;
  $('helperState').textContent = errors.join(' | ');
  $('found').hidden = !found.length;
  if (!found.length) { if (!errors.length) $('helperState').textContent = 'No videos found at that link.'; return; }
  $('foundTitle').textContent = `${titles.join(', ') || 'Videos'}: ${found.length} video${found.length === 1 ? '' : 's'}`;
  $('foundList').innerHTML = '';
  found.forEach((v, i) => {
    const l = document.createElement('label');
    l.innerHTML = `<input type="checkbox" checked data-i="${i}"><span class="t"></span><span class="d"></span>`;
    l.querySelector('.t').textContent = v.title;
    l.querySelector('.d').textContent = v.duration ? shortTime(v.duration) : '';
    $('foundList').appendChild(l);
  });
  $('selAll').checked = true;
  updateQueueBtn();
});

function selectedFound() { return [...$('foundList').querySelectorAll('input:checked')].map((c) => found[+c.dataset.i]); }
function updateQueueBtn() {
  const n = selectedFound().length;
  $('queueBtn').textContent = `Transcribe ${n} video${n === 1 ? '' : 's'}`;
  $('queueBtn').disabled = !n;
}
$('foundList').addEventListener('change', updateQueueBtn);
$('selAll').addEventListener('change', (e) => {
  $('foundList').querySelectorAll('input').forEach((c) => (c.checked = e.target.checked));
  updateQueueBtn();
});
$('queueBtn').addEventListener('click', () => {
  for (const v of selectedFound()) {
    const job = { id: nextId++, url: v.url, title: v.title, status: 'queued', text: '', chunks: [] };
    job.el = renderCard(job);
    $('list').appendChild(job.el);
    jobs.push(job);
  }
  $('found').hidden = true;
  updateSummary();
  run();
  $('toolbar').scrollIntoView({ behavior: 'smooth' });
});

const $ = (id) => document.getElementById(id);
const worker = new Worker('worker.js', { type: 'module' });

const jobs = [];          // { id, file, status, text, chunks, el, startedAt, secs }
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
async function decodeAudio(file) {
  const buf = await file.arrayBuffer();
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
  el.querySelector('.name').textContent = job.file.name;
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
    decoding: '<span class="spin"></span>Extracting audio',
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
    let audio;
    try {
      audio = await decodeAudio(job.file);
    } catch {
      job.status = 'error';
      job.text = "Couldn't read the audio track. The file may have no sound or use a codec this browser can't decode (try MP4 or WebM).";
      updateCard(job); updateSummary(); continue;
    }
    job.status = 'working'; updateCard(job);
    setStatus(`Transcribing ${job.file.name} (${fmtDur(audio.length / 16000)} of audio)…`, null);
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
function baseName(job) { return job.file.name.replace(/\.[^.]+$/, ''); }
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

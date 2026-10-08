// Runs Whisper fully in the browser (WebGPU when available, WASM otherwise).
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.0.2';

env.allowLocalModels = false;

let transcriber = null;
let loadedKey = null;

async function hasWebGPU() {
  try {
    if (!navigator.gpu) return false;
    const adapter = await navigator.gpu.requestAdapter();
    return !!adapter;
  } catch { return false; }
}

async function load(model) {
  const gpu = await hasWebGPU();
  const key = model + (gpu ? ':gpu' : ':cpu');
  if (transcriber && loadedKey === key) return gpu;

  const progress_callback = (p) => self.postMessage({ type: 'load-progress', data: p });
  const opts = gpu
    ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback }
    : { device: 'wasm', dtype: 'q8', progress_callback };

  try {
    transcriber = await pipeline('automatic-speech-recognition', model, opts);
  } catch (err) {
    if (!gpu) throw err;
    // WebGPU failed on this machine: fall back to CPU.
    transcriber = await pipeline('automatic-speech-recognition', model,
      { device: 'wasm', dtype: 'q8', progress_callback });
    loadedKey = model + ':cpu';
    return false;
  }
  loadedKey = key;
  return gpu;
}

self.onmessage = async (e) => {
  const { type, id, audio, model, language } = e.data;
  try {
    if (type === 'load') {
      const gpu = await load(model);
      self.postMessage({ type: 'ready', gpu });
      return;
    }
    if (type === 'transcribe') {
      await load(model);
      const opts = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true };
      if (!model.endsWith('.en')) {
        opts.task = 'transcribe';
        if (language && language !== 'auto') opts.language = language;
      }
      const out = await transcriber(audio, opts);
      self.postMessage({ type: 'result', id, text: out.text.trim(), chunks: out.chunks || [] });
    }
  } catch (err) {
    self.postMessage({ type: 'error', id, message: String(err && err.message || err) });
  }
};

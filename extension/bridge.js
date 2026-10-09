// Runs on the Bulk Video Transcriber website and relays its requests to the extension.
(() => {
  const VERSION = chrome.runtime.getManifest().version;
  const hello = () => window.postMessage({ __bt: 'hello', version: VERSION }, location.origin);

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data) return;
    const m = e.data;
    if (m.__bt === 'ping') return hello();
    if (m.__bt !== 'req') return;

    const port = chrome.runtime.connect({ name: 'bt' });
    const parts = [];
    let size = 0;
    const reply = (msg, transfer) => window.postMessage({ __bt: 'res', id: m.id, ...msg }, location.origin, transfer);

    port.onMessage.addListener((r) => {
      if (r.kind === 'progress') return window.postMessage({ __bt: 'progress', id: m.id, text: r.text }, location.origin);
      if (r.kind === 'chunk') {
        const bin = atob(r.b64);
        const u = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
        parts.push(u); size += u.length;
        return;
      }
      if (r.kind === 'done') {
        const all = new Uint8Array(size);
        let o = 0;
        for (const p of parts) { all.set(p, o); o += p.length; }
        reply({ ok: true, buffer: all.buffer }, [all.buffer]);
      } else if (r.kind === 'result') reply({ ok: true, data: r.data });
      else if (r.kind === 'error') reply({ ok: false, error: r.error });
      port.disconnect();
    });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) reply({ ok: false, error: 'The extension stopped unexpectedly. Try again.' });
    });
    port.postMessage({ type: m.type, payload: m.payload });
  });

  hello();
})();

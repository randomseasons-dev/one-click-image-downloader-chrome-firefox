// Offscreen page: the service worker can't write files or make blob URLs, so it hands
// images over through IndexedDB ("pending") and this page does the disk work.
const blobUrls = new Set();
let idleTimer;

chrome.runtime.onMessage.addListener((m, _s, reply) => {
  if (m?.to !== 'ocsi-offscreen') return;
  handle(m).then(reply, e => reply({ error: String(e?.message || e) }));
  return true;
});

async function handle(m) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {               // idle for 5 min: free memory and go away
    for (const u of blobUrls) URL.revokeObjectURL(u);
    window.close();
  }, 5 * 60e3);

  const item = await OCSI_DB.get('pending', m.id);
  if (!item) return { error: 'missing image data' };

  if (m.cmd === 'url') {
    const url = URL.createObjectURL(item.blob);
    blobUrls.add(url);
    await OCSI_DB.del('pending', m.id);
    return { url };
  }

  if (m.cmd === 'write') {
    const dir = await OCSI_DB.get('kv', 'dir');
    if (!dir) return { error: 'nofolder' };
    if ((await dir.queryPermission({ mode: 'readwrite' })) !== 'granted') return { needPermission: true };
    const name = await ocsiWriteUnique(dir, item.name, item.blob);
    await OCSI_DB.del('pending', m.id);
    return { ok: true, name, folder: dir.name };
  }
  return { error: 'unknown command' };
}

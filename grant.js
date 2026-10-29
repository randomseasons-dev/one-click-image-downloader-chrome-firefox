// Popup opened when folder permission has lapsed. The button click is the user gesture
// requestPermission() needs; then every image waiting for the folder is written.
const $ = id => document.getElementById(id);

(async () => {
  const dir = await OCSI_DB.get('kv', 'dir');
  if (dir) $('dir').textContent = dir.name;
  const waiting = (await OCSI_DB.entries('pending')).filter(e => e.value.perm).length;
  $('count').textContent = waiting ? `${waiting} image${waiting > 1 ? 's' : ''} waiting.` : '';

  $('allow').onclick = async () => {
    if (!dir || (await dir.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      $('status').textContent = 'Access was not granted.';
      return;
    }
    for (const { key, value } of await OCSI_DB.entries('pending')) {
      if (!value.perm) continue;
      const name = await ocsiWriteUnique(dir, value.name, value.blob);
      await OCSI_DB.del('pending', key);
      EXT.runtime.sendMessage({ type: 'ocsi:saved', tabId: value.tabId, name });
    }
    window.close();
  };
  $('fallback').onclick = async () => {
    await EXT.runtime.sendMessage({ type: 'ocsi:fallback' }).catch(() => {});
    window.close();
  };
})();

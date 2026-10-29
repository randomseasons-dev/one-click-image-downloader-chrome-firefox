// Settings page. Every change saves immediately.
const $ = id => document.getElementById(id);
const RESERVED = new Set(['ctrl+KeyT', 'ctrl+KeyN', 'ctrl+KeyW', 'ctrl+shift+KeyT', 'ctrl+shift+KeyN', 'ctrl+shift+KeyW', 'ctrl+Tab']);
let statusTimer;

function saved(text = 'Saved ✓') {
  $('status').textContent = text;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => ($('status').textContent = ''), 1800);
}
const save = obj => EXT.storage.sync.set(obj).then(() => saved());

function keyLabel(e) {
  if (/^Key[A-Z]$/.test(e.code)) return e.code.slice(3);
  if (/^Digit\d$/.test(e.code)) return e.code.slice(5);
  if (/^F\d+$/.test(e.code)) return e.code;
  return e.key.length === 1 ? e.key.toUpperCase() : e.code;
}

function checkReserved(cfg) {
  const hit = RESERVED.has(`${cfg.hkMods}+${cfg.hkCode}`);
  $('hkWarn').hidden = !hit;
  $('hkWarn').textContent = hit ? 'The browser keeps this combination for itself; pick another.' : '';
}

async function showFolder() {
  const dir = await OCSI_DB.get('kv', 'dir').catch(() => null);
  $('dirName').textContent = dir ? dir.name : 'No folder chosen';
  $('regrant').hidden = !dir || (await dir.queryPermission({ mode: 'readwrite' })) === 'granted';
}

async function init() {
  const cfg = await EXT.storage.sync.get(OCSI_DEFAULTS);
  $('hkEnabled').checked = cfg.hkEnabled;
  $('hkMods').value = cfg.hkMods;
  $('hkKey').value = cfg.hkLabel;
  $('subfolder').value = cfg.subfolder;
  for (const k of ['hires', 'unblock', 'toast']) $(k).checked = cfg[k];
  document.querySelector(`input[name=mode][value=${cfg.mode}]`).checked = true;
  checkReserved(cfg);

  const firefox = !EXT.offscreen;                // Firefox: no offscreen API, no folder picker
  const fsOk = !firefox && typeof window.showDirectoryPicker === 'function';
  $('fsMissing').hidden = fsOk || firefox;
  $('fsFirefox').hidden = !firefox;
  $('browse').disabled = !fsOk;
  if (firefox) {
    document.querySelector('input[name=mode][value=folder]').disabled = true;
    document.querySelector('input[name=mode][value=downloads]').checked = true;
  }
  if (fsOk) showFolder();

  // Firefox lets people switch off "Access your data for all websites"; the extension needs it.
  const ALL = { origins: ['<all_urls>'] };
  const showAccess = async () => { $('access').hidden = await EXT.permissions.contains(ALL); };
  showAccess();
  $('grantAccess').onclick = async () => { await EXT.permissions.request(ALL); showAccess(); };

  $('hkEnabled').onchange = e => save({ hkEnabled: e.target.checked });
  $('hkMods').onchange = e => { cfg.hkMods = e.target.value; checkReserved(cfg); save({ hkMods: cfg.hkMods }); };
  $('hkKey').onkeydown = e => {
    e.preventDefault();
    if (/^(Shift|Control|Alt|Meta)/.test(e.code) || e.code === 'Tab') return;
    cfg.hkCode = e.code; cfg.hkLabel = keyLabel(e);
    $('hkKey').value = cfg.hkLabel;
    checkReserved(cfg);
    save({ hkCode: cfg.hkCode, hkLabel: cfg.hkLabel });
  };
  $('subfolder').oninput = e => save({ subfolder: e.target.value.trim() });
  for (const k of ['hires', 'unblock', 'toast']) $(k).onchange = e => save({ [k]: e.target.checked });

  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.onchange = async () => {
      if (r.value === 'folder' && !(await OCSI_DB.get('kv', 'dir').catch(() => null))) {
        if (!(await pick())) { document.querySelector('input[name=mode][value=downloads]').checked = true; return; }
      }
      save({ mode: r.value });
    };
  }
  $('browse').onclick = pick;
  $('regrant').onclick = async () => {
    const dir = await OCSI_DB.get('kv', 'dir');
    if (dir && (await dir.requestPermission({ mode: 'readwrite' })) === 'granted') saved('Access granted ✓');
    showFolder();
  };
}

async function pick() {
  try {
    const dir = await window.showDirectoryPicker({ id: 'ocsi', mode: 'readwrite', startIn: 'pictures' });
    await OCSI_DB.set('kv', 'dir', dir);
    document.querySelector('input[name=mode][value=folder]').checked = true;
    await save({ mode: 'folder' });
    showFolder();
    return true;
  } catch (e) {
    if (e.name !== 'AbortError') $('status').textContent = 'Could not use that folder: ' + e.message;
    return false;
  }
}

init();

// One-Click Save Image — background (service worker in Chrome/Brave, event page in Firefox).
// Context menu + shortcut → ask the frame under the cursor for its image → fetch every
// candidate (bypassing CORS / hotlink checks) → keep the largest → write it to disk.
// Firefox loads defaults.js and shared.js through the manifest instead.
if (typeof importScripts === 'function') importScripts('defaults.js', 'shared.js');

const MENU_ID = 'ocsi-save';
const MAX_CANDIDATES = 12;
const REFERER_RULE = 1;

async function createMenu() {
  await EXT.contextMenus.removeAll();
  EXT.contextMenus.create({ id: MENU_ID, title: 'One-click save image', contexts: ['all'] });
}
EXT.runtime.onStartup.addListener(createMenu);   // Firefox doesn't always keep menus across restarts

EXT.runtime.onInstalled.addListener(async () => {
  await createMenu();
  // Tabs that were open before install have no content script yet.
  const tabs = await EXT.tabs.query({ url: ['http://*/*', 'https://*/*', 'file://*/*'] });
  for (const t of tabs) inject(t.id);
});

EXT.action.onClicked.addListener(() => EXT.runtime.openOptionsPage());

EXT.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !tab?.id) return;
  enqueue(() => run(tab, info.frameId ?? 0, true, info.srcUrl || null));
});

EXT.runtime.onMessage.addListener((m, sender) => {
  if (m?.type === 'ocsi:hotkey' && sender.tab) {
    const tab = sender.tab;
    enqueue(async () => run(tab, await frameUnderMouse(tab.id, sender.frameId), false, null));
  } else if (m?.type === 'ocsi:saved') {
    toast(m.tabId, `Saved ${m.name}`, 'ok');
  } else if (m?.type === 'ocsi:fallback') {
    enqueue(flushPendingToDownloads);
  }
});

EXT.windows.onRemoved.addListener(async id => {
  const { grantWin } = await EXT.storage.session.get('grantWin');
  if (grantWin === id) EXT.storage.session.remove('grantWin');
});

// One save at a time: keeps the Referer rule and the toasts in order.
let chain = Promise.resolve();
const enqueue = fn => (chain = chain.then(fn).catch(e => console.error('[ocsi]', e)));

const inject = tabId => EXT.scripting.executeScript({
  target: { tabId, allFrames: true }, files: ['defaults.js', 'content.js'],
}).catch(() => {});

async function ask(tabId, frameId, msg) {
  try { return await EXT.tabs.sendMessage(tabId, msg, { frameId }); } catch { return undefined; }
}

async function toast(tabId, text, kind) {
  if (tabId == null) return;
  if (kind !== 'err') {
    const { toast: on } = await EXT.storage.sync.get({ toast: OCSI_DEFAULTS.toast });
    if (!on) return;
  }
  ask(tabId, 0, { type: 'ocsi:toast', text, kind });
}

// The shortcut arrives in the focused frame; the image is in the frame the mouse last moved in.
async function frameUnderMouse(tabId, fallback) {
  try {
    const res = await EXT.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (window.__ocsi && window.__ocsi.t) || 0,
    });
    let best = null;
    for (const r of res) if (r.result && (!best || r.result > best.result)) best = r;
    if (best) return best.frameId;
  } catch {}
  return fallback ?? 0;
}

// ---------- main flow ----------

async function run(tab, frameId, useCtx, srcUrl) {
  const cfg = await EXT.storage.sync.get(OCSI_DEFAULTS);
  let t = await ask(tab.id, frameId, { type: 'ocsi:collect', useCtx });
  if (t === undefined) { await inject(tab.id); t = await ask(tab.id, frameId, { type: 'ocsi:collect', useCtx }); }
  t = t || { found: false, urls: [], primary: null, pageUrl: tab.url, title: tab.title };
  if (srcUrl) {                                   // the browser's own idea of the image
    if (!t.urls.includes(srcUrl)) t.urls.push(srcUrl);
    t.primary ||= srcUrl;
  }

  let picked = null;
  if (t.primary || t.urls.length) picked = await pickBest(t, cfg.hires, tab.id, frameId);
  if (!picked && frameId === 0 && t.rect) picked = await screenshotCrop(tab, t);
  if (!picked) {
    const direct = [t.primary, ...t.urls].find(u => /^https?:/i.test(u || ''));
    if (direct) {                                 // last resort: let the browser download it
      const filename = withSub(cfg.subfolder, cleanName(fileBase(direct) || 'image') || 'image');
      await EXT.downloads.download({ url: direct, filename, conflictAction: 'uniquify', saveAs: false });
      return toast(tab.id, 'Site refused the request — handed it to the browser download instead', 'info');
    }
    return toast(tab.id, 'No image found under the cursor', 'err');
  }

  const name = makeName(picked, t);
  const res = await deliver(picked.blob, name, cfg, tab.id);
  const dims = picked.w ? ` (${picked.w}×${picked.h})` : '';
  if (res.pendingGrant) return toast(tab.id, 'Click "Allow" in the popup to keep saving into your folder', 'info');
  const note = picked.shot ? ' — screenshot, the site blocked the file' : '';
  toast(tab.id, `Saved ${res.name}${dims} → ${res.where}${note}${res.note || ''}`, picked.shot ? 'info' : 'ok');
}

// ---------- candidates ----------

async function pickBest(t, hires, tabId, frameId) {
  let urls;
  if (hires) {
    urls = [];
    for (const u of t.urls) {
      if (/^https?:/i.test(u)) urls.push(...upgrades(u));
      urls.push(u);
    }
    urls = [...new Set(urls)];
    if (urls.length > MAX_CANDIDATES) {
      urls = urls.slice(0, MAX_CANDIDATES);
      if (t.primary && !urls.includes(t.primary)) urls[MAX_CANDIDATES - 1] = t.primary;
    }
  } else {
    urls = [t.primary || t.urls[t.urls.length - 1]];
  }

  await setReferer(t.pageUrl, urls);
  let got;
  try {
    got = await Promise.all(urls.map((u, rank) => load(u).then(r => r && { ...r, rank }, () => null)));
  } finally {
    await clearReferer();
  }
  got = got.filter(Boolean);

  if (!got.length) {                              // try again from inside the page
    for (const u of [t.primary, ...t.urls].filter(u => /^https?:/i.test(u || ''))) {
      const data = await ask(tabId, frameId, { type: 'ocsi:pageFetch', url: u });
      const r = data && await load(data).catch(() => null);
      if (r) { got.push({ ...r, finalUrl: u, rank: 0 }); break; }
    }
  }
  got.sort((a, b) => (b.px - a.px) || (b.size - a.size) || (a.rank - b.rank));
  return got[0] || null;
}

// Guesses at the full-size file for sites that serve resized copies. Wrong guesses just 404.
function upgrades(u) {
  let p;
  try { p = new URL(u); } catch { return []; }
  const out = [];
  const add = s => { if (s && s !== u) out.push(s); };
  const h = p.hostname, path = p.pathname;
  const IMG = '(?=\\.(?:jpe?g|png|gif|webp|avif)(?:$|[?#]))';

  if (h === 'pbs.twimg.com' && path.startsWith('/media/')) {
    const q = new URL(u.replace(/:\w+$/, ''));
    q.searchParams.set('name', 'orig');
    add(q.href);
  }
  if (h === 'i.pinimg.com') add(u.replace(/\/\d+x\d*\//, '/originals/'));
  if (h === 'preview.redd.it') add(`https://i.redd.it${path}`);
  if (/(^|\.)(googleusercontent|ggpht)\.com$|\.bp\.blogspot\.com$/.test(h)) {
    add(u.replace(/=[swh]\d+[^/?#]*$/, '=s0'));
    add(u.replace(/\/[swh]\d+(-[^/]*)?\//, '/s0/'));
  }
  if (h === 'upload.wikimedia.org') {
    const m = /^(.*)\/thumb(\/.+?)\/[^/]+$/.exec(path);
    if (m) add(p.origin + m[1] + m[2]);
  }
  if (/(^|\.)(media-amazon|ssl-images-amazon)\.com$/.test(h)) add(u.replace(/\._[^/]*?_\.(\w+)$/, '.$1'));
  if (h === 'i.etsystatic.com') add(u.replace(/il_\d+x\d+\./, 'il_fullxfull.'));
  if (h === 'i.imgur.com') {
    const m = /^\/(\w{7})[sbtmlh]\.(\w+)$/.exec(path);
    if (m) add(`https://i.imgur.com/${m[1]}.${m[2]}`);
  }
  if (/(^|\.)staticflickr\.com$/.test(h)) add(u.replace(/_[mnwzcsqt]\.jpg$/, '_b.jpg'));
  if (/(^|\.)artstation\.com$/.test(h)) {
    add(u.replace(/\/(smaller_square|small|medium|large)\//, '/4k/'));
    add(u.replace(/\/(smaller_square|small|medium)\//, '/large/'));
  }
  if (h === 'cdn.shopify.com' || path.includes('/cdn/shop/')) {
    add(u.replace(new RegExp('_(\\d+x\\d*|x\\d+|pico|icon|thumb|small|compact|medium|large|grande)(@\\dx)?' + IMG, 'i'), ''));
  }
  // WordPress & co: photo-300x200.jpg / photo-scaled.jpg → photo.jpg
  add(u.replace(new RegExp('-\\d{2,5}x\\d{2,5}' + IMG, 'i'), ''));
  add(u.replace(new RegExp('-scaled' + IMG, 'i'), ''));
  // Resizing query parameters (?w=300&h=200&fit=crop) → ask for the original.
  const SIZE = /^(w|h|width|height|size|resize|fit|crop|dpr|q|quality|scale|maxwidth|maxheight|mw|mh|imwidth|imheight)$/i;
  if ([...p.searchParams.keys()].some(k => SIZE.test(k))) {
    const q = new URL(u);
    for (const k of [...q.searchParams.keys()]) if (SIZE.test(k)) q.searchParams.delete(k);
    add(q.href);
  }
  return [...new Set(out)];
}

// Send the page as Referer so hotlink-protected hosts answer the worker's requests.
async function setReferer(pageUrl, urls) {
  if (!/^https?:/i.test(pageUrl || '')) return;
  const hosts = [...new Set(urls.map(u => { try { return /^https?:/.test(u) ? new URL(u).hostname : null; } catch { return null; } }).filter(Boolean))];
  if (!hosts.length) return;
  try {
    await EXT.declarativeNetRequest.updateSessionRules({
      removeRuleIds: [REFERER_RULE],
      addRules: [{
        id: REFERER_RULE,
        priority: 1,
        action: { type: 'modifyHeaders', requestHeaders: [{ header: 'Referer', operation: 'set', value: pageUrl }] },
        condition: { tabIds: [EXT.tabs.TAB_ID_NONE], requestDomains: hosts, resourceTypes: ['xmlhttprequest', 'other'] },
      }],
    });
  } catch (e) { console.warn('[ocsi] referer rule', e); }
}
const clearReferer = () => EXT.declarativeNetRequest.updateSessionRules({ removeRuleIds: [REFERER_RULE] }).catch(() => {});

// Fetch one candidate; null unless it really is an image. px = pixel count for ranking.
async function load(u) {
  let blob, finalUrl = u;
  if (u.startsWith('data:')) {
    blob = await (await fetch(u)).blob();
    finalUrl = null;
  } else {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      const r = await fetch(u, { credentials: 'include', signal: ctrl.signal });
      if (!r.ok) return null;
      blob = await r.blob();
      finalUrl = r.url || u;
    } finally { clearTimeout(timer); }
  }
  const head = new Uint8Array(await blob.slice(0, 32).arrayBuffer());
  let type = sniff(head);
  if (!type && /^image\//i.test(blob.type)) type = blob.type.toLowerCase();
  if (!type) return null;

  let w = 0, h = 0, px = 0;
  if (type === 'image/svg+xml') px = Number.MAX_SAFE_INTEGER;   // vector: any size
  else {
    try { const bm = await createImageBitmap(blob); w = bm.width; h = bm.height; px = w * h; bm.close(); } catch {}
  }
  if (blob.type !== type) blob = new Blob([blob], { type });
  return { blob, type, w, h, px, size: blob.size, finalUrl };
}

function sniff(b) {
  const at = (o, ...v) => v.every((x, i) => b[o + i] === x);
  if (at(0, 0xFF, 0xD8, 0xFF)) return 'image/jpeg';
  if (at(0, 0x89, 0x50, 0x4E, 0x47)) return 'image/png';
  if (at(0, 0x47, 0x49, 0x46, 0x38)) return 'image/gif';
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return 'image/webp';
  if (at(4, 0x66, 0x74, 0x79, 0x70)) {
    const brand = String.fromCharCode(...b.slice(8, 12));
    if (/avi[fs]/.test(brand)) return 'image/avif';
    if (/hei[cxms]|hev[cx]|mif1|msf1/.test(brand)) return 'image/heic';
  }
  if (at(0, 0xFF, 0x0A) || at(0, 0, 0, 0, 0x0C, 0x4A, 0x58, 0x4C, 0x20)) return 'image/jxl';
  if (at(0, 0x49, 0x49, 0x2A, 0) || at(0, 0x4D, 0x4D, 0, 0x2A)) return 'image/tiff';
  if (at(0, 0x42, 0x4D)) return 'image/bmp';
  if (at(0, 0, 0, 1, 0)) return 'image/x-icon';
  const txt = String.fromCharCode(...b).trimStart().toLowerCase();
  if (txt.startsWith('<svg')) return 'image/svg+xml';
  return '';
}

// Crop the element out of a screenshot — works whatever the site does to the file itself.
async function screenshotCrop(tab, t) {
  try {
    const shot = await EXT.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    const bmp = await createImageBitmap(await (await fetch(shot)).blob());
    const k = bmp.width / t.vw;                   // CSS px → screenshot px (covers zoom + DPI)
    const x0 = Math.max(0, t.rect.x), y0 = Math.max(0, t.rect.y);
    const x1 = Math.min(t.vw, t.rect.x + t.rect.w), y1 = Math.min(t.vh, t.rect.y + t.rect.h);
    const sx = Math.round(x0 * k), sy = Math.round(y0 * k);
    const w = Math.round((x1 - x0) * k), h = Math.round((y1 - y0) * k);
    if (w < 2 || h < 2) return null;
    const c = new OffscreenCanvas(w, h);
    c.getContext('2d').drawImage(bmp, sx, sy, w, h, 0, 0, w, h);
    bmp.close();
    const blob = await c.convertToBlob({ type: 'image/png' });
    return { blob, type: 'image/png', w, h, px: w * h, size: blob.size, finalUrl: null, shot: true };
  } catch (e) {
    console.warn('[ocsi] screenshot', e);
    return null;
  }
}

// ---------- naming ----------

const MIME_EXT = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif',
  'image/bmp': 'bmp', 'image/svg+xml': 'svg', 'image/tiff': 'tif', 'image/x-icon': 'ico',
  'image/heic': 'heic', 'image/jxl': 'jxl',
};
const GENERIC = /^(image|img|photo|picture|pic|download|file|media|default|original|orig|large|full|index|raw|0|1)$/i;

function fileBase(url) {
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(seg);
  } catch { return ''; }
}

function stamp() {
  const d = new Date(), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function cleanName(s) {
  s = String(s).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '');
  if (s.length > 120) s = s.slice(0, 120).trim();
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s = '_' + s;
  return s;
}

function makeName(p, t) {
  let base = p.finalUrl ? fileBase(p.finalUrl).replace(/\.[a-z0-9]{2,5}$/i, '') : '';
  base = cleanName(base);
  if (base.length < 2 || GENERIC.test(base)) base = cleanName(`${t.alt || t.title || 'image'} ${stamp()}`);
  return `${base || 'image ' + stamp()}.${MIME_EXT[p.type] || 'img'}`;
}

function withSub(sub, name) {
  const parts = String(sub || '').split(/[\\/]+/).map(cleanName).filter(s => s && s !== '..' && s !== '.');
  return parts.length ? parts.join('/') + '/' + name : name;
}

// ---------- writing ----------

let creating;
async function ensureOffscreen() {
  const has = await EXT.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (has.length) return;
  creating ||= EXT.offscreen.createDocument({
    url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Write saved images to the chosen folder',
  }).finally(() => { creating = null; });
  await creating;
}

async function toOffscreen(msg) {
  for (let i = 0; ; i++) {
    await ensureOffscreen();
    try {
      const r = await EXT.runtime.sendMessage({ to: 'ocsi-offscreen', ...msg });
      if (r !== undefined) return r;
    } catch (e) { if (i) throw e; }
    if (i) return null;
  }
}

async function deliver(blob, name, cfg, tabId) {
  let note = '';
  if (cfg.mode === 'folder' && EXT.offscreen) {     // Firefox has no folder picker: Downloads only
    const id = crypto.randomUUID();
    await OCSI_DB.set('pending', id, { blob, name, tabId });
    const r = await toOffscreen({ cmd: 'write', id });
    if (r?.ok) return { name: r.name, where: r.folder };
    if (r?.needPermission) {
      await OCSI_DB.set('pending', id, { blob, name, tabId, perm: true });
      await openGrant();
      return { pendingGrant: true };
    }
    await OCSI_DB.del('pending', id);
    note = r?.error === 'nofolder' ? ' (no folder chosen yet — open the extension settings)' : ` (folder write failed: ${r?.error})`;
  }
  return { ...(await viaDownloads(blob, name, cfg.subfolder)), note };
}

async function viaDownloads(blob, name, sub) {
  const filename = withSub(sub, name);
  if (!EXT.offscreen && typeof URL.createObjectURL === 'function') {
    // Firefox's background is a page, so it can make the blob URL itself.
    const url = URL.createObjectURL(blob);
    try {
      const dlId = await EXT.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false });
      revokeWhenDone(dlId, url);
    } catch (e) { URL.revokeObjectURL(url); throw e; }
  } else {
    // Chrome's service worker can't make blob URLs: the offscreen page does it.
    const id = crypto.randomUUID();
    await OCSI_DB.set('pending', id, { blob, name });
    const r = await toOffscreen({ cmd: 'url', id });
    if (!r?.url) throw new Error(r?.error || 'could not prepare the download');
    await EXT.downloads.download({ url: r.url, filename, conflictAction: 'uniquify', saveAs: false });
  }
  const dir = filename.slice(0, -name.length - 1);
  return { name, where: dir ? 'Downloads/' + dir : 'Downloads' };
}

function revokeWhenDone(dlId, url) {
  const done = () => { EXT.downloads.onChanged.removeListener(watch); clearTimeout(timer); URL.revokeObjectURL(url); };
  const watch = d => { if (d.id === dlId && d.state && d.state.current !== 'in_progress') done(); };
  const timer = setTimeout(done, 5 * 60e3);
  EXT.downloads.onChanged.addListener(watch);
}

async function openGrant() {
  const { grantWin } = await EXT.storage.session.get('grantWin');
  if (grantWin) {
    try { await EXT.windows.update(grantWin, { focused: true }); return; } catch {}
  }
  const w = await EXT.windows.create({ url: 'grant.html', type: 'popup', width: 480, height: 320, focused: true });
  await EXT.storage.session.set({ grantWin: w.id });
}

// The user refused folder access: send everything waiting for it to Downloads instead.
async function flushPendingToDownloads() {
  const { subfolder } = await EXT.storage.sync.get({ subfolder: OCSI_DEFAULTS.subfolder });
  for (const { key, value } of await OCSI_DB.entries('pending')) {
    if (!value.perm) continue;
    await OCSI_DB.del('pending', key);
    const r = await viaDownloads(value.blob, value.name, subfolder);
    toast(value.tabId, `Saved ${r.name} → ${r.where}`, 'ok');
  }
}

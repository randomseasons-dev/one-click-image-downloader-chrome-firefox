// One-Click Save Image — content script (runs in every frame).
// Tracks the cursor, finds the image under it even through overlays and blocked right-click,
// fires the keyboard shortcut, and answers the background worker.
(() => {
  if (window.__ocsi?.alive?.()) return;

  const alive = () => { try { return !!chrome.runtime?.id; } catch { return false; } };
  // t = last mouse move, read by the worker to find which frame the cursor is in.
  const S = (window.__ocsi = { x: -1, y: -1, t: 0, cx: -1, cy: -1, alive });
  let cfg = { ...OCSI_DEFAULTS };

  chrome.storage.sync.get(OCSI_DEFAULTS).then(v => { cfg = v; }, () => {});
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'sync') for (const k in ch) cfg[k] = ch[k].newValue ?? OCSI_DEFAULTS[k];
  });

  addEventListener('mousemove', e => {
    S.x = e.clientX; S.y = e.clientY; S.t = Date.now();
  }, { capture: true, passive: true });

  // Remember where the menu opened. Over an image, stop the page's own handlers so a site
  // can't cancel the browser menu (window capture runs before every page listener).
  addEventListener('contextmenu', e => {
    if (!alive() || !e.isTrusted) return;
    S.cx = S.x = e.clientX; S.cy = S.y = e.clientY; S.t = Date.now();
    if (!cfg.unblock) return;
    const hit = findAt(e.clientX, e.clientY);
    if (hit && !(hit.kind === 'bg' && (hit.el === document.body || hit.el === document.documentElement))) {
      e.stopImmediatePropagation();
    }
  }, true);

  addEventListener('keydown', e => {
    if (!alive() || !cfg.hkEnabled || e.repeat || !e.isTrusted || e.code !== cfg.hkCode) return;
    const m = cfg.hkMods || '';
    if (e.ctrlKey !== m.includes('ctrl') || e.altKey !== m.includes('alt') ||
        e.shiftKey !== m.includes('shift') || e.metaKey) return;
    if (m === 'shift' && isEditable(e.composedPath()[0])) return; // don't eat capital letters
    e.preventDefault();
    e.stopImmediatePropagation();
    chrome.runtime.sendMessage({ type: 'ocsi:hotkey' }).catch(() => {});
  }, true);

  chrome.runtime.onMessage.addListener((m, _s, reply) => {
    if (m?.type === 'ocsi:collect') {
      collect(m.useCtx).then(reply, e => reply({ found: false, urls: [], error: String(e) }));
      return true;
    }
    if (m?.type === 'ocsi:pageFetch') {
      pageFetch(m.url).then(reply, () => reply(null));
      return true;
    }
    if (m?.type === 'ocsi:toast') toast(m.text, m.kind);
  });

  // ---------- finding the image ----------

  const IMG_EXT = /\.(jpe?g|jfif|pjpeg|png|apng|gif|webp|avif|bmp|svg|tiff?|jxl|heic|heif|ico)$/i;
  const IMG_HOST = /^(pbs\.twimg\.com|i\.redd\.it|i\.imgur\.com|i\.pinimg\.com|images\.unsplash\.com|cdn\.discordapp\.com|media\.discordapp\.net|[a-z0-9-]+\.googleusercontent\.com|upload\.wikimedia\.org)$/i;
  // Attributes galleries, lazy-loaders and lightboxes use for the full-size file.
  const DATA_ATTRS = [
    'data-full', 'data-fullsrc', 'data-full-src', 'data-full-url', 'data-fullsize', 'data-original',
    'data-orig-file', 'data-large-file', 'data-large', 'data-zoom', 'data-zoom-image', 'data-zoom-src',
    'data-hi-res', 'data-hires', 'data-highres', 'data-src-large', 'data-big', 'data-image',
    'data-lazy-src', 'data-src', 'data-srcset', 'data-lazy-srcset', 'data-bg', 'data-background',
    'data-background-image',
  ];

  const isEditable = el => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  function abs(u) {
    if (!u || typeof u !== 'string') return null;
    u = u.trim();
    if (!u || /^(javascript:|about:|#)/i.test(u)) return null;
    try { return new URL(u, document.baseURI).href; } catch { return null; }
  }
  const uniq = list => [...new Set(list.filter(Boolean))];

  function looksImage(u) {
    try {
      const p = new URL(u);
      if (p.protocol === 'data:') return /^data:image\//i.test(u);
      if (!/^https?:$/.test(p.protocol)) return false;
      return IMG_EXT.test(p.pathname) || IMG_HOST.test(p.hostname) ||
        /[?&](format|fm|ext)=(jpe?g|png|webp|gif|avif)\b/i.test(p.search);
    } catch { return false; }
  }

  // Largest candidate of a srcset ("a.jpg 640w, b.jpg 1280w" / "a.jpg 1x, b.jpg 2x").
  function bestOfSrcset(s) {
    if (!s) return null;
    let best = null, bestScore = -1, i = 0;
    const n = s.length;
    while (i < n) {
      while (i < n && /[\s,]/.test(s[i])) i++;
      let j = i;
      while (j < n && !/\s/.test(s[j])) j++;
      let url = s.slice(i, j), desc = '';
      if (url.endsWith(',')) url = url.replace(/,+$/, '');
      else {
        let k = j;
        while (k < n && s[k] !== ',') k++;
        desc = s.slice(j, k).trim();
        j = k + 1;
      }
      i = j;
      if (!url) continue;
      const m = /^(\d+(?:\.\d+)?)([wx])$/i.exec(desc.split(/\s+/)[0] || '');
      const score = m ? +m[1] : 1;
      if (score > bestScore) { best = url; bestScore = score; }
    }
    return best;
  }

  function attrUrls(el) {
    const out = [];
    for (const n of DATA_ATTRS) {
      const v = el.getAttribute(n);
      if (!v) continue;
      if (n.endsWith('srcset')) out.push(bestOfSrcset(v));
      else if (!/[\s{}<>]/.test(v.trim())) out.push(v);
    }
    return out;
  }

  function imgUrls(img) {
    const list = [];
    const pic = img.closest('picture');
    if (pic) for (const s of pic.querySelectorAll('source')) list.push(bestOfSrcset(s.srcset || s.getAttribute('data-srcset')));
    list.push(bestOfSrcset(img.srcset), ...attrUrls(img), img.currentSrc, img.src);
    return uniq(list.map(abs));
  }

  function bgUrls(el) {
    const out = [];
    for (const pseudo of [null, '::before', '::after']) {
      const v = getComputedStyle(el, pseudo).backgroundImage;
      if (v && v !== 'none') for (const m of v.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) out.push(m[2]);
    }
    return out;
  }

  function visible(el) {
    const cs = getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 4 && r.height >= 4;
  }

  // What image (if any) does this one element show?
  function fromEl(el) {
    if (el === toastHost) return null;
    const tag = el.tagName;
    if (tag === 'IMG') {
      if (!visible(el)) return null;
      if (el.complete && el.naturalWidth > 0 && el.naturalWidth * el.naturalHeight <= 4) return null; // spacer gif
      return { el, kind: 'img', primary: abs(el.currentSrc || el.src), urls: imgUrls(el) };
    }
    if (el instanceof SVGImageElement) {
      const u = abs(el.href?.baseVal || el.getAttribute('xlink:href'));
      return u ? { el, kind: 'img', primary: u, urls: [u] } : null;
    }
    if (tag === 'VIDEO') {
      if (!visible(el)) return null;
      const poster = abs(el.poster);
      return { el, kind: 'video', primary: poster, urls: poster ? [poster] : [] };
    }
    if (tag === 'CANVAS') return visible(el) ? { el, kind: 'canvas', primary: null, urls: [] } : null;
    if (tag === 'INPUT' && el.type === 'image') {
      const u = abs(el.src);
      return u ? { el, kind: 'img', primary: u, urls: [u] } : null;
    }
    const bg = uniq(bgUrls(el).map(abs));
    if (bg.length) {
      const r = el.getBoundingClientRect();
      if (r.width >= 4 && r.height >= 4) return { el, kind: 'bg', primary: bg[0], urls: uniq([...attrUrls(el).map(abs), ...bg]) };
    }
    return null;
  }

  // Every element under the point, top first, descending into open shadow roots.
  function stackAt(x, y) {
    const seen = new Set(), out = [];
    const walk = (root, depth) => {
      let els;
      try { els = root.elementsFromPoint(x, y); } catch { return; }
      for (const el of els) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (el.shadowRoot && depth < 5) walk(el.shadowRoot, depth + 1);
        out.push(el);
      }
    };
    walk(document, 0);
    return out;
  }

  // Images with pointer-events:none are invisible to elementsFromPoint; find them by geometry.
  function scanAt(x, y) {
    const els = document.querySelectorAll('img, video, canvas');
    for (let i = els.length - 1; i >= 0; i--) {
      const r = els[i].getBoundingClientRect();
      if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
        const hit = fromEl(els[i]);
        if (hit) return hit;
      }
    }
    return null;
  }

  // Image files linked from the image or from an overlay link above it.
  function linkUrls(stack, el) {
    const idx = stack.indexOf(el);
    const scope = idx >= 0 ? stack.slice(0, idx + 1) : [el, ...stack.slice(0, 3)];
    let a = null;
    for (const e of scope) { a = e.closest?.('a[href]'); if (a) break; }
    if (!a) return [];
    return uniq([a.getAttribute('href'), ...attrUrls(a)].map(abs)).filter(looksImage);
  }

  function findAt(x, y) {
    if (x < 0 || y < 0) return null;
    const stack = stackAt(x, y);
    let hit = null;
    for (const el of stack) { hit = fromEl(el); if (hit) break; }
    if (!hit) hit = scanAt(x, y);
    if (hit) hit.link = linkUrls(stack, hit.el);
    return hit;
  }

  // ---------- turning it into something the worker can fetch ----------

  const blobToDataUrl = b => new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(r.error);
    r.readAsDataURL(b);
  });

  // blob: URLs only exist inside this page, so read them here.
  async function fetchable(u) {
    if (!u || !u.startsWith('blob:')) return u;
    try { return await blobToDataUrl(await (await fetch(u)).blob()); } catch { return null; }
  }

  // Current frame of a canvas / video; fails (null) when the pixels are cross-origin.
  function grabFrame(el) {
    try {
      if (el.tagName === 'CANVAS') return el.width && el.height ? el.toDataURL('image/png') : null;
      if (el.readyState < 2 || !el.videoWidth) return null;
      if (el.poster && el.paused && el.currentTime === 0) return null; // poster is what's shown
      const c = document.createElement('canvas');
      c.width = el.videoWidth; c.height = el.videoHeight;
      c.getContext('2d').drawImage(el, 0, 0);
      return c.toDataURL('image/png');
    } catch { return null; }
  }

  async function collect(useCtx) {
    const x = useCtx && S.cx >= 0 ? S.cx : S.x;
    const y = useCtx && S.cy >= 0 ? S.cy : S.y;
    const base = { pageUrl: location.href, title: document.title, vw: innerWidth, vh: innerHeight };
    const hit = findAt(x, y);
    if (!hit) return { ...base, found: false, urls: [], primary: null };

    let primary = hit.primary;
    let urls = [...hit.link, ...hit.urls];
    if (hit.kind === 'canvas' || hit.kind === 'video') {
      const frame = grabFrame(hit.el);
      if (frame) { primary = frame; urls.unshift(frame); }
    }
    const cache = new Map();
    const conv = u => { if (!cache.has(u)) cache.set(u, fetchable(u)); return cache.get(u); };
    urls = uniq(await Promise.all(uniq(urls).map(conv)));
    primary = await conv(primary);

    const r = hit.el.getBoundingClientRect();
    return {
      ...base, found: true, kind: hit.kind, primary, urls,
      rect: { x: r.left, y: r.top, w: r.width, h: r.height },
      alt: (hit.el.getAttribute?.('alt') || hit.el.getAttribute?.('title') || '').trim(),
    };
  }

  // Fallback when the worker's own request was refused: fetch with this page's cookies and
  // referrer, or copy pixels from an already-loaded same-origin image.
  async function pageFetch(url) {
    try {
      const r = await fetch(url);
      if (r.ok) return await blobToDataUrl(await r.blob());
    } catch {}
    const img = [...document.images].find(i => i.currentSrc === url || i.src === url);
    if (img?.complete && img.naturalWidth) {
      try {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext('2d').drawImage(img, 0, 0);
        return c.toDataURL('image/png');
      } catch {}
    }
    return null;
  }

  // ---------- toast ----------

  let toastHost, toastBox, toastTimer;
  function toast(text, kind) {
    if (window !== top || !document.documentElement) return;
    if (!toastHost) {
      toastHost = document.createElement('ocsi-toast');
      toastHost.style.cssText = 'all:initial!important;position:fixed!important;right:20px!important;' +
        'bottom:20px!important;z-index:2147483647!important;pointer-events:none!important;';
      const root = toastHost.attachShadow({ mode: 'closed' });
      root.innerHTML = `<style>
        .t{font:500 13px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#f5f7fa;background:#1d2330;
           border-left:4px solid #22c55e;border-radius:8px;padding:10px 14px;max-width:380px;
           box-shadow:0 6px 24px rgba(0,0,0,.35);opacity:0;transform:translateY(8px);
           transition:opacity .18s,transform .18s;word-break:break-word}
        .t.show{opacity:1;transform:none}
        .t.err{border-left-color:#ef4444}.t.info{border-left-color:#3b82f6}
      </style><div class="t"></div>`;
      toastBox = root.querySelector('.t');
    }
    if (!toastHost.isConnected) document.documentElement.appendChild(toastHost);
    toastBox.textContent = text;
    toastBox.className = 't ' + (kind || '');
    requestAnimationFrame(() => toastBox.classList.add('show'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastBox.classList.remove('show'), kind === 'err' ? 5000 : 2600);
  }
})();

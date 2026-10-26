// IndexedDB helpers and the folder writer, shared by the worker and the extension pages.
// Store "kv" holds the chosen FileSystemDirectoryHandle ("dir"); store "pending" holds images
// on their way to disk ({ blob, name, tabId, perm }).
var OCSI_DB = (() => {
  let dbp;
  const open = () => dbp || (dbp = new Promise((res, rej) => {
    const r = indexedDB.open('ocsi', 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore('kv');
      r.result.createObjectStore('pending');
    };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  }));

  async function run(store, mode, fn) {
    const db = await open();
    return new Promise((res, rej) => {
      const t = db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out instanceof IDBRequest ? out.result : out);
      t.onerror = t.onabort = () => rej(t.error);
    });
  }

  return {
    get: (s, k) => run(s, 'readonly', st => st.get(k)),
    set: (s, k, v) => run(s, 'readwrite', st => st.put(v, k)),
    del: (s, k) => run(s, 'readwrite', st => st.delete(k)),
    entries: s => run(s, 'readonly', st => {
      const all = [];
      st.openCursor().onsuccess = e => {
        const c = e.target.result;
        if (c) { all.push({ key: c.key, value: c.value }); c.continue(); }
      };
      return all;
    }),
  };
})();

// Write `blob` into `dir` as `name`, adding " (1)", " (2)"… when the name is taken.
async function ocsiWriteUnique(dir, name, blob) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 0; i < 10000; i++) {
    const n = i ? `${base} (${i})${ext}` : name;
    try {
      await dir.getFileHandle(n);
      continue;                                   // exists
    } catch (e) {
      if (e.name === 'TypeMismatchError') continue; // a folder with that name
      if (e.name !== 'NotFoundError') throw e;
    }
    const fh = await dir.getFileHandle(n, { create: true });
    const w = await fh.createWritable();
    await w.write(blob);
    await w.close();
    return n;
  }
  throw new Error('Too many files named ' + name);
}

// Base de datos local de DICA NBA.
// Reemplaza a Firestore con las mismas funciones que usaban index.html e
// importador.html, pero guarda todo en IndexedDB, dentro del navegador.
// Los datos viven solo en este navegador y dispositivo: la app y el importador
// los comparten si se abren desde el mismo sitio.
(function () {
  'use strict';

  const DB_NAME = 'dica-nba', STORE = 'docs';
  const mem = new Map();          // respaldo si IndexedDB no está disponible
  let idbPromise = null;

  function openIdb() {
    if (idbPromise) return idbPromise;
    idbPromise = new Promise(resolve => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => {
          const st = req.result.createObjectStore(STORE, { keyPath: 'path' });
          st.createIndex('coll', 'coll');
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => { console.warn('IndexedDB no disponible; los datos no se guardarán', req.error); resolve(null); };
      } catch (e) {
        console.warn('IndexedDB no disponible; los datos no se guardarán', e);
        resolve(null);
      }
    });
    return idbPromise;
  }
  const reqP = r => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  async function readOne(path) {
    const idb = await openIdb();
    if (!idb) return mem.get(path) || null;
    return (await reqP(idb.transaction(STORE).objectStore(STORE).get(path))) || null;
  }
  async function readColl(coll) {
    const idb = await openIdb();
    if (!idb) return [...mem.values()].filter(r => r.coll === coll);
    return reqP(idb.transaction(STORE).objectStore(STORE).index('coll').getAll(coll));
  }
  // ops: [{ type: 'put', rec } | { type: 'del', path }], en una sola transacción
  async function writeMany(ops) {
    const idb = await openIdb();
    if (!idb) { ops.forEach(o => o.type === 'put' ? mem.set(o.rec.path, o.rec) : mem.delete(o.path)); return; }
    await new Promise((res, rej) => {
      const tx = idb.transaction(STORE, 'readwrite'), st = tx.objectStore(STORE);
      ops.forEach(o => o.type === 'put' ? st.put(o.rec) : st.delete(o.path));
      tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  }

  // ---------- Valores especiales ----------
  class ArrayUnion { constructor(items) { this.items = items; } }
  const arrayUnion = (...items) => new ArrayUnion(items);
  const Timestamp = {
    fromDate: d => ({ seconds: Math.floor(d.getTime() / 1000), nanoseconds: 0 }),
    now: () => Timestamp.fromDate(new Date()),
  };

  const isPlain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof ArrayUnion);
  const sameVal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  function resolveVal(v, old) {
    if (v instanceof ArrayUnion) {
      const base = Array.isArray(old) ? old.slice() : [];
      v.items.forEach(x => { if (!base.some(y => sameVal(x, y))) base.push(x); });
      return base;
    }
    if (isPlain(v)) { const o = {}; for (const k in v) if (v[k] !== undefined) o[k] = resolveVal(v[k], undefined); return o; }
    if (Array.isArray(v)) return v.map(x => resolveVal(x, undefined));
    return v;
  }
  // Igual que setDoc(..., { merge: true }) de Firestore: une mapas anidados,
  // reemplaza arreglos y valores simples.
  function deepMerge(old, inc) {
    const out = isPlain(old) ? { ...old } : {};
    for (const k in inc) {
      const v = inc[k];
      if (v === undefined) continue;
      out[k] = isPlain(v) && isPlain(out[k]) ? deepMerge(out[k], v) : resolveVal(v, out[k]);
    }
    return out;
  }
  const clone = v => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)));

  // ---------- API estilo Firestore ----------
  const db = { local: true };
  const doc = (_db, coll, id) => ({ type: 'doc', coll, id: String(id), path: coll + '/' + id });
  const collection = (_db, coll) => ({ type: 'coll', coll, constraints: [] });

  function makeSnap(ref, rec) {
    return {
      id: ref.id, ref,
      exists: () => !!rec,
      data: () => (rec ? clone(rec.data) : undefined),
    };
  }
  async function getDoc(ref) { return makeSnap(ref, await readOne(ref.path)); }

  async function buildPut(ref, data, opts) {
    let value;
    if (opts && opts.merge) { const old = await readOne(ref.path); value = deepMerge(old ? old.data : {}, data); }
    else value = resolveVal(data, undefined);
    return { type: 'put', rec: { path: ref.path, coll: ref.coll, id: ref.id, data: value } };
  }
  async function setDoc(ref, data, opts) { await writeMany([await buildPut(ref, data, opts)]); }
  async function deleteDoc(ref) { await writeMany([{ type: 'del', path: ref.path }]); }

  function writeBatch() {
    const pending = [];
    return {
      set(ref, data, opts) { pending.push({ kind: 'set', ref, data, opts }); return this; },
      delete(ref) { pending.push({ kind: 'del', ref }); return this; },
      async commit() {
        // Se resuelven en orden para que varios set con merge al mismo doc se acumulen.
        const staged = new Map();
        for (const p of pending) {
          if (p.kind === 'del') { staged.set(p.ref.path, { type: 'del', path: p.ref.path }); continue; }
          let op;
          if (p.opts && p.opts.merge) {
            const prev = staged.get(p.ref.path);
            const base = prev ? (prev.type === 'put' ? prev.rec.data : {}) : ((await readOne(p.ref.path)) || {}).data || {};
            op = { type: 'put', rec: { path: p.ref.path, coll: p.ref.coll, id: p.ref.id, data: deepMerge(base, p.data) } };
          } else op = await buildPut(p.ref, p.data, null);
          staged.set(p.ref.path, op);
        }
        await writeMany([...staged.values()]);
      },
    };
  }

  const orderBy = (field, dir = 'asc') => ({ kind: 'orderBy', field, dir });
  const where = (field, op, value) => ({ kind: 'where', field, op, value });
  const limit = n => ({ kind: 'limit', n });
  const query = (coll, ...constraints) => ({ ...coll, constraints: [...(coll.constraints || []), ...constraints] });

  const OPS = {
    '<': (a, b) => a < b, '<=': (a, b) => a <= b, '>': (a, b) => a > b, '>=': (a, b) => a >= b,
    '==': (a, b) => sameVal(a, b), '!=': (a, b) => !sameVal(a, b),
  };
  async function getDocs(q) {
    let recs = await readColl(q.coll);
    for (const c of q.constraints || []) {
      if (c.kind === 'where') recs = recs.filter(r => r.data[c.field] !== undefined && OPS[c.op](r.data[c.field], c.value));
    }
    const ord = (q.constraints || []).filter(c => c.kind === 'orderBy');
    if (ord.length) {
      recs = recs.filter(r => ord.every(o => r.data[o.field] !== undefined));
      recs.sort((a, b) => {
        for (const o of ord) {
          const x = a.data[o.field], y = b.data[o.field];
          if (x < y) return o.dir === 'desc' ? 1 : -1;
          if (x > y) return o.dir === 'desc' ? -1 : 1;
        }
        return 0;
      });
    } else recs.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const lim = (q.constraints || []).find(c => c.kind === 'limit');
    if (lim) recs = recs.slice(0, lim.n);
    const docs = recs.map(r => makeSnap({ type: 'doc', coll: r.coll, id: r.id, path: r.path }, r));
    return { docs, size: docs.length, empty: !docs.length, forEach: fn => docs.forEach(fn) };
  }

  // ---------- Copia de seguridad ----------
  async function exportAll() {
    const idb = await openIdb();
    const recs = idb ? await reqP(idb.transaction(STORE).objectStore(STORE).getAll()) : [...mem.values()];
    return { app: 'dica-nba', version: 1, exportado: new Date().toISOString(), docs: recs };
  }
  async function importAll(payload, { replace = false } = {}) {
    if (!payload || !Array.isArray(payload.docs)) throw new Error('El archivo no es una copia de DICA NBA.');
    const ops = [];
    if (replace) {
      const idb = await openIdb();
      const all = idb ? await reqP(idb.transaction(STORE).objectStore(STORE).getAllKeys()) : [...mem.keys()];
      all.forEach(path => ops.push({ type: 'del', path }));
    }
    payload.docs.forEach(r => { if (r && r.path && r.coll && r.id) ops.push({ type: 'put', rec: { path: r.path, coll: r.coll, id: r.id, data: r.data } }); });
    await writeMany(ops);
    return payload.docs.length;
  }

  window.LocalDB = {
    db, doc, collection, getDoc, getDocs, setDoc, deleteDoc, writeBatch,
    query, orderBy, where, limit, arrayUnion, Timestamp, exportAll, importAll,
  };
})();

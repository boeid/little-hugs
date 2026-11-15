'use strict';
/* Shared log – keeps the same data on several phones (the Android app and the web app).

   The whole log is one file, data.json, in a private GitHub repository; pictures are separate
   files under photos/. Each phone downloads the file, merges it with its own copy and uploads
   the result. Merging is per record: the copy changed last wins (`u`, set in app.js save()), and
   a record deleted on one phone (db.dead) is deleted on the other.

   The repository name and access token are kept in this phone's localStorage only – they are
   never written into the log itself. */
(function () {
  const KEY = 'bc_sync', UP = 'bc_sync_up', API = 'https://api.github.com/repos/';
  let cfg = null;
  try { cfg = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { }
  const state = { busy: false, last: 0, error: '' };
  let timer = 0, again = false;
  const changed = () => { if (window.onSyncState) window.onSyncState(); };

  // ---- base64 <-> text (UTF-8) ----
  function encode(text) {
    const b = new TextEncoder().encode(text); let s = '';
    for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return btoa(s);
  }
  function decode(b64) {
    const s = atob(b64.replace(/\s/g, '')), b = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i);
    return new TextDecoder().decode(b);
  }

  // ---- GitHub ----
  function problem(status) {
    return new Error(status === 401 ? 'GitHub did not accept the access token (it may have expired)'
      : status === 403 ? 'GitHub refused – the token may not allow writing to this repository, or too many requests were made'
      : status === 404 ? 'the repository was not found, or the token cannot open it'
      : 'GitHub answered with error ' + status);
  }
  async function api(c, path, opt) {
    let r;
    try {
      r = await fetch(API + c.repo + path, Object.assign({ cache: 'no-store' }, opt, {
        headers: { Authorization: 'Bearer ' + c.token, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
      }));
    } catch (e) { throw new Error('no internet connection'); }
    return r;
  }
  // A file's base64 content and version (`sha`), or null if it does not exist yet.
  async function getFile(path) {
    const r = await api(cfg, '/contents/' + path);
    if (r.status === 404) return null;
    if (!r.ok) throw problem(r.status);
    const j = await r.json();
    let b64 = j.content;
    if (!b64) { // files over 1 MB come without content
      const b = await api(cfg, '/git/blobs/' + j.sha);
      if (!b.ok) throw problem(b.status);
      b64 = (await b.json()).content;
    }
    return { b64, sha: j.sha };
  }
  // Uploads a file. `sha` must be the version being replaced; GitHub answers 409/422 if someone else changed it meanwhile.
  function putFile(path, b64, sha, message) {
    return api(cfg, '/contents/' + path, { method: 'PUT', body: JSON.stringify({ message, content: b64, sha: sha || undefined }) });
  }

  // ---- merging ----
  const sortKeys = o => { const out = {}; for (const k of Object.keys(o || {}).sort()) out[k] = o[k]; return out; };
  // `mine` is this phone's log, `theirs` the stored one. Neither is changed.
  function merge(mine, theirs) {
    const out = { dead: {}, meta: {} };
    for (const d of [mine.dead || {}, theirs.dead || {}]) for (const id in d) if (!(out.dead[id] >= d[id])) out.dead[id] = d[id];
    out.dead = sortKeys(out.dead);
    for (const k of LISTS) {
      const m = new Map();
      for (const x of mine[k] || []) m.set(x.id, x);
      for (const y of theirs[k] || []) { const x = m.get(y.id); if (!x || (y.u || 0) >= (x.u || 0)) m.set(y.id, y); }
      out[k] = Array.from(m.values()).filter(x => !(out.dead[x.id] >= (x.u || 0))).sort((p, q) => p.id < q.id ? -1 : p.id > q.id ? 1 : 0);
    }
    const prod = Object.assign({}, mine.products);
    for (const c in theirs.products || {}) if (!prod[c] || (theirs.products[c].u || 0) >= (prod[c].u || 0)) prod[c] = theirs.products[c];
    out.products = sortKeys(prod);
    // `check` (medicines in the interaction checker) and `settings` are each one value.
    const mm = mine.meta || {}, tm = theirs.meta || {};
    const pick = (key, both) => {
      const a = mm[key] || 0, b = tm[key] || 0;
      out.meta[key] = Math.max(a, b);
      return theirs[key] === undefined || a > b ? mine[key] : b > a ? theirs[key] : both(mine[key], theirs[key]);
    };
    out.check = pick('check', (a, b) => Array.from(new Set((b || []).concat(a || []))));
    out.settings = pick('settings', (a, b) => Object.assign({}, a, b));
    return out;
  }
  const canon = d => JSON.stringify({
    events: d.events || [], meds: d.meds || [], notes: d.notes || [], reminders: d.reminders || [],
    products: sortKeys(d.products), check: d.check || [], settings: d.settings || {}, dead: sortKeys(d.dead), meta: sortKeys(d.meta)
  });

  // ---- pictures ----
  async function syncPhotos() {
    await photosReady;
    const need = Array.from(new Set(savedPhotos()));
    if (!need.length) return;
    const here = new Set(await Photos.list());
    let up; try { up = new Set(JSON.parse(localStorage.getItem(UP) || '[]')); } catch (e) { up = new Set(); }
    let got = false;
    try {
      for (const name of need) {
        if (here.has(name)) {
          if (up.has(name)) continue;
          const r = await putFile('photos/' + name, await Photos.read(name), null, 'Add picture');
          if (!r.ok && r.status !== 409 && r.status !== 422) throw problem(r.status);   // 409/422: it is already there
          up.add(name);
        } else {
          const f = await getFile('photos/' + name);
          if (!f) continue;   // the other phone has not uploaded it yet
          await Photos.write(name, f.b64.replace(/\s/g, ''));
          up.add(name); got = true;
        }
      }
    } finally {
      localStorage.setItem(UP, JSON.stringify(Array.from(up).filter(n => need.includes(n))));
      if (got && document.querySelector('#sheet').hidden) render();
    }
  }

  // ---- the sync itself ----
  async function run() {
    if (!cfg) return;
    if (state.busy) { again = true; return; }
    state.busy = true; changed();
    try {
      for (let attempt = 0; ; attempt++) {
        const f = await getFile('data.json');
        const theirs = f ? JSON.parse(decode(f.b64)) : {};
        // From here to applySynced() nothing waits, so an entry typed during the download is not lost.
        const merged = merge(db, theirs), both = canon(merged);
        if (both !== canon(db)) applySynced(merged);
        if (both === canon(theirs)) break;
        const r = await putFile('data.json', encode(both), f && f.sha, 'Update log');
        if (r.ok) break;
        if ((r.status !== 409 && r.status !== 422) || attempt >= 4) throw problem(r.status);
      }
      await syncPhotos();
      state.last = Date.now(); state.error = '';
    } catch (e) {
      state.error = e.message || String(e);
    } finally {
      state.busy = false; changed();
      if (again) { again = false; soon(); }
    }
  }
  function soon() { if (!cfg) return; clearTimeout(timer); timer = setTimeout(run, 1500); }

  window.Sync = {
    state,
    config: () => cfg,
    now: run,
    soon,
    merge,   // exposed for testing
    // Checks that the repository can be opened, then turns the shared log on. Returns an error text or ''.
    async setup(repo, token) {
      const c = { repo, token };
      try {
        const r = await api(c, '');
        if (!r.ok) throw problem(r.status);
        const info = await r.json();
        if (info.permissions && !info.permissions.push) return 'This token can read the repository but not write to it';
        if (info.private === false) return 'This repository is public – everyone could read the log. Use a private one';
      } catch (e) { return e.message; }
      cfg = c; localStorage.setItem(KEY, JSON.stringify(c)); localStorage.removeItem(UP);
      state.error = ''; state.last = 0;
      run();
      return '';
    },
    off() { cfg = null; localStorage.removeItem(KEY); localStorage.removeItem(UP); clearTimeout(timer); state.error = ''; state.last = 0; }
  };

  // Update when the app is opened or comes back to the front, and once a minute while it is in view.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(); });
  setInterval(() => { if (!document.hidden) run(); }, 60000);
  soon();
})();

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

  // ---- reminders on an iPhone ----
  /* A web app cannot ring an alarm itself; a small server (BabyCare/worker) sends the notification
     when a reminder is due. A family that runs such a server puts its address in push.json in
     their log repository: { url, key, vapid }. Every phone sharing the log then sends the server
     the reminder schedule, and an iPhone also sends the address it receives notifications at.
     Without push.json none of this does anything. */
  const PUSH = 'bc_push', SUB = 'bc_push_sub', DEV = 'bc_dev';
  let push = null, pushChecked = 0;
  try { push = JSON.parse(localStorage.getItem(PUSH) || 'null'); } catch (e) { }
  const keepPush = () => localStorage.setItem(PUSH, JSON.stringify(push));
  const mySub = () => localStorage.getItem(SUB) || '';
  function device() {
    let d = localStorage.getItem(DEV);
    if (!d) { d = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(DEV, d); }
    return d;
  }
  const schedule = () => ({
    tz: -new Date().getTimezoneOffset(),
    meds: db.meds.filter(m => m.enabled !== false && (m.times || []).length).map(m => ({ name: m.name, dose: m.dose || '', times: m.times })),
    rems: db.reminders.filter(r => r.enabled !== false).map(r => ({ text: r.text, ts: r.ts, unit: r.unit || '', every: r.every || 1, from: r.from || 0 }))
  });
  async function post(path, body) {
    let r;
    try {
      r = await fetch(push.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ key: push.key }, body)) });
    } catch (e) { throw new Error('no internet connection'); }
    if (!r.ok) throw new Error('the reminder server answered with error ' + r.status);
    return r.json();
  }
  async function syncPush() {
    // Look for push.json when the app starts, then every 10 minutes until found and every 6 hours after.
    if (!pushChecked || Date.now() - pushChecked > (push && push.url ? 6 * 3600e3 : 600e3)) {
      const f = await getFile('push.json');
      let c = null; try { c = f && JSON.parse(decode(f.b64)); } catch (e) { }
      pushChecked = Date.now();
      const had = !!(push && push.url);
      if (!c || !c.url || !c.key) push = {};
      else if (!push || push.url !== c.url || push.key !== c.key) push = { url: c.url, key: c.key, vapid: c.vapid };
      else push.vapid = c.vapid;
      keepPush();
      if (had !== !!push.url) changed();
    }
    if (!push.url) return;
    const day = 86400e3, s = JSON.stringify(schedule());
    if (s !== push.sched || Date.now() - (push.schedAt || 0) > day) {
      await post('/sched', JSON.parse(s));
      push.sched = s; push.schedAt = Date.now(); keepPush();
    }
    // Sent again once a day, in case the server dropped this phone after a failed delivery.
    const sub = mySub();
    if (sub !== (push.sub || '') || (sub && Date.now() - (push.subAt || 0) > day)) {
      await post('/sub', { id: device(), sub: sub ? JSON.parse(sub) : null });
      push.sub = sub; push.subAt = Date.now(); keepPush();
    }
  }
  const b64uBytes = s => { const t = atob(s.replace(/-/g, '+').replace(/_/g, '/')), b = new Uint8Array(t.length); for (let i = 0; i < t.length; i++) b[i] = t.charCodeAt(i); return b; };
  const Push = {
    // 'none': no server, or this is the Android app (which rings by itself); 'install': open from the Home Screen first;
    // 'off' / 'on': can ring here, and whether it is turned on.
    state() {
      if (hasNative || !cfg || !push || !push.url || !push.vapid) return 'none';
      if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'install';
      return mySub() && Notification.permission === 'granted' ? 'on' : 'off';
    },
    // Both return an error text or ''.
    async on() {
      try {
        if (await Notification.requestPermission() !== 'granted')
          return 'Notifications are not allowed. Allow them in Settings → Notifications → Little Hugs';
        const reg = await navigator.serviceWorker.ready;
        const old = await reg.pushManager.getSubscription();
        if (old) await old.unsubscribe();   // it may belong to an earlier server key
        const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64uBytes(push.vapid) });
        localStorage.setItem(SUB, JSON.stringify(sub.toJSON()));
        await syncPush();
        return '';
      } catch (e) { return e.message || String(e); }
    },
    async off() {
      try {
        const reg = await navigator.serviceWorker.ready, sub = await reg.pushManager.getSubscription();
        if (sub) await sub.unsubscribe();
        localStorage.removeItem(SUB);
        await syncPush();
        return '';
      } catch (e) { return e.message || String(e); }
    },
    async test() {
      try {
        const r = await post('/test', { sub: JSON.parse(mySub()) });
        return r.ok ? '' : 'the notification service refused it (' + r.status + ')';
      } catch (e) { return e.message || String(e); }
    }
  };

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
      try { await syncPush(); } catch (e) { console.log('reminder server: ' + e.message); }   // never blocks the log itself
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
    push: Push,
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
      push = null; pushChecked = 0; localStorage.removeItem(PUSH);
      state.error = ''; state.last = 0;
      run();
      return '';
    },
    off() {
      cfg = null; push = null; pushChecked = 0;
      for (const k of [KEY, UP, PUSH]) localStorage.removeItem(k);
      clearTimeout(timer); state.error = ''; state.last = 0;
    }
  };

  // Update when the app is opened or comes back to the front, and once a minute while it is in view.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) soon(); });
  setInterval(() => { if (!document.hidden) run(); }, 60000);
  soon();
})();

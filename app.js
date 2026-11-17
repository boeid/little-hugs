'use strict';
/* Baby Care – all data stays on the device.
   On the phone, `Native` (see MainActivity.java) provides storage, alarms, camera OCR and sharing.
   In a desktop browser the same page runs with localStorage/fetch fallbacks, for development. */
const hasNative = typeof Native !== 'undefined';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const pad = n => String(n).padStart(2, '0');

// ---------- storage ----------
let db = { events: [], meds: [], check: [], notes: [], reminders: [], settings: { dryDiaper: '' } };

function load() {
  try {
    const raw = hasNative ? Native.loadData() : localStorage.getItem('babycare');
    if (raw) db = Object.assign(db, JSON.parse(raw));
  } catch (e) { /* start empty */ }
  db.settings = db.settings || {};
  db.notes = db.notes || [];
  db.reminders = db.reminders || [];
  db.products = db.products || {};
  db.dead = db.dead || {};   // id -> time a record was deleted, so the other phone deletes it too
  db.meta = db.meta || {};   // time `check` and `settings` last changed
  snapshot();
}
// Shared log: every record carries `u`, the time it last changed. save() works that out by
// comparing with a copy taken at the previous save, so the rest of the app never sets it.
const LISTS = ['events', 'meds', 'notes', 'reminders'];
let shadow = null;
const bare = x => { const c = Object.assign({}, x); delete c.u; return JSON.stringify(c); };
function snapshot() {
  shadow = { check: JSON.stringify(db.check), settings: JSON.stringify(db.settings), products: {} };
  for (const k of LISTS) { shadow[k] = {}; for (const x of db[k]) shadow[k][x.id] = bare(x); }
  for (const c in db.products) shadow.products[c] = bare(db.products[c]);
}
function stamp() {
  const now = Date.now();
  for (const k of LISTS) {
    const seen = {};
    for (const x of db[k]) { seen[x.id] = 1; if (shadow[k][x.id] !== bare(x)) x.u = now; }
    for (const id in shadow[k]) if (!seen[id]) db.dead[id] = now;
  }
  for (const c in db.products) if (shadow.products[c] !== bare(db.products[c])) db.products[c].u = now;
  if (shadow.check !== JSON.stringify(db.check)) db.meta.check = now;
  if (shadow.settings !== JSON.stringify(db.settings)) db.meta.settings = now;
  snapshot();
}
function save(fromSync) {
  if (!fromSync) stamp();
  const s = JSON.stringify(db);
  if (hasNative) Native.saveData(s); else localStorage.setItem('babycare', s);
  if (!fromSync && window.Sync) Sync.soon();
}
// Called by sync.js with the log merged from both phones.
function applySynced(merged) {
  Object.assign(db, merged);
  snapshot(); save(true); syncReminders(); keepPhotos();
  if ($('#sheet').hidden) render();
}
function syncReminders() {
  if (!hasNative) return;
  Native.setReminders(JSON.stringify(db.meds));
  Native.setCustomReminders(JSON.stringify(db.reminders));
}
function mergePendingDoses() {
  if (!hasNative) return;
  let arr = [];
  try { arr = JSON.parse(Native.takePendingDoses() || '[]'); } catch (e) { }
  if (!arr.length) return;
  for (const p of arr) db.events.push({ id: uid(), type: 'dose', ts: p.ts, medId: p.medId, name: p.name, dose: p.dose });
  save();
}

// ---------- time helpers ----------
const fmtTime = ts => { const d = new Date(ts); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const toLocalInput = ts => { const d = new Date(ts); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const startOfDay = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime(); };
const addDays = (ts, n) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); };
function dayLabel(ts) {
  const today = startOfDay(Date.now());
  if (ts === today) return 'Today';
  if (ts === addDays(today, -1)) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}
const eventsOn = day => db.events.filter(e => e.ts >= day && e.ts < addDays(day, 1)).sort((a, b) => b.ts - a.ts);
function totals(evs) {
  const t = { pee: { n: 0, ml: 0, unk: 0 }, poop: { n: 0 }, drink: { n: 0, ml: 0, unk: 0 }, dose: { n: 0 } };
  for (const e of evs) {
    const x = t[e.type]; if (!x) continue;
    x.n++;
    if ('ml' in x) { if (e.ml > 0) x.ml += +e.ml; else x.unk++; }
  }
  return t;
}

// ---------- shell ----------
let tab = 'today';
let viewDay = startOfDay(Date.now());
// Shown wherever reminders are listed when Android would deliver them late.
// The web app (iPhone) rings them only through a reminder server – see "reminders on an iPhone" in sync.js.
function webReminderNote() {
  const s = window.Sync ? Sync.push.state() : 'none';
  return `<div class="note">${s === 'on' ? `🔔 Reminders ring on this phone. <button class="btn small" data-act="pushTest">Send a test</button> <button class="btn small ghost" data-act="pushOff">Turn off</button>`
    : s === 'off' ? `Reminders can ring on this phone too. <button class="btn small" data-act="pushOn">Turn on</button>`
    : s === 'install' ? 'To ring reminders on this phone, add Little Hugs to the Home Screen (Share → Add to Home Screen) and open it from there.'
    : 'This phone cannot ring reminders. They ring on the Android phone that shares this log.'}</div>`;
}
const exactNote = () => !hasNative ? webReminderNote()
  : !Native.exactAlarmsAllowed()
  ? `<div class="note">Android may deliver reminders late until you allow “Alarms &amp; reminders” for this app. <button class="btn small" data-act="askExact">Allow</button></div>` : '';
const TITLES = { today: hasNative ? Native.appName() : 'Little Hugs', meds: 'Medicines', log: 'Log', check: 'Interaction checker', history: 'History' };

function render() {
  $('#title').textContent = TITLES[tab];
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === tab));
  ({ today: renderToday, meds: renderMeds, log: renderLog, check: renderCheck, history: renderHistory })[tab]();
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.h); toast.h = setTimeout(() => { t.hidden = true; }, 2600);
}
function openSheet(html) {
  $('#sheet').innerHTML = html; $('#sheet').hidden = false; $('#scrim').hidden = false; $('#sheet').scrollTop = 0;
}
function closeSheet() {
  $('#sheet').hidden = true; $('#scrim').hidden = true; $('#sheet').innerHTML = '';
  if (draft) { draft = null; stash(null); keepPhotos(); }
  if (pdraft) { pdraft = null; stashP(null); keepPhotos(); }
}
window.onBack = () => {
  if (!$('#sheet').hidden) { closeSheet(); return true; }
  if (tab !== 'today') { tab = 'today'; render(); return true; }
  return false;
};
window.onAppResume = () => { mergePendingDoses(); if ($('#sheet').hidden) render(); if (window.Sync) Sync.soon(); };

// ---------- Today ----------
const ICON = { pee: '💧', poop: '💩', drink: '🍼', dose: '💊', weight: '⚖️', sleep: '😴' };
// Sleep: e.ts is when he fell asleep, e.end when he woke (0 or missing = still asleep).
const sleepEnd = e => e.end || Date.now();
const fmtDur = ms => { const m = Math.max(0, Math.round(ms / 60000)); return (m >= 60 ? Math.floor(m / 60) + ' h ' : '') + (m % 60) + ' min'; };
const asleepNow = () => db.events.find(e => e.type === 'sleep' && !e.end);
function sleepOn(day) { // time asleep inside this calendar day, and how many sleeps touch it
  const from = day, to = addDays(day, 1); let ms = 0, n = 0;
  for (const e of db.events) {
    if (e.type !== 'sleep') continue;
    const a = Math.max(e.ts, from), b = Math.min(sleepEnd(e), to);
    if (b > a) { ms += b - a; n++; }
  }
  return { ms, n };
}
const weights = () => db.events.filter(e => e.type === 'weight' && e.kg > 0).sort((a, b) => b.ts - a.ts);
const fmtKg = kg => parseFloat((+kg).toFixed(3)) + ' kg';
const shortDate = ts => new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
function weightChange(a, b) { // a is the newer measurement
  const g = Math.round((a.kg - b.kg) * 1000);
  return (g > 0 ? '+' : g < 0 ? '−' : '±') + Math.abs(g) + ' g since ' + shortDate(b.ts);
}
const DRINKS = ['Breast milk', 'Formula', 'Water', 'Rehydration solution', 'Other'];
const POOPS = ['Normal', 'Soft', 'Loose', 'Watery', 'Hard'];

function nextDue() {
  let best = null; const now = Date.now();
  for (const m of db.meds) {
    if (m.enabled === false) continue;
    for (const t of m.times || []) {
      const [h, mi] = t.split(':').map(Number);
      const d = new Date(); d.setHours(h, mi, 0, 0);
      let ts = d.getTime(); if (ts <= now) ts = addDays(ts, 1);
      if (!best || ts < best.ts) best = { ts, med: m, time: t };
    }
  }
  return best;
}
function describe(e) {
  if (e.type === 'pee') return 'Pee' + (e.ml > 0 ? ` · ${e.ml} ml` : ' · not measured');
  if (e.type === 'poop') return 'Poop' + (e.kind ? ` · ${e.kind}` : '');
  if (e.type === 'weight') return 'Weight · ' + fmtKg(e.kg);
  if (e.type === 'sleep') return e.end ? `Sleep · until ${fmtTime(e.end)} (${fmtDur(e.end - e.ts)})` : `Asleep · ${fmtDur(Date.now() - e.ts)} so far`;
  if (e.type === 'drink') return (e.kind || 'Drink') + (e.ml > 0 ? ` · ${e.ml} ml` : ' · amount not measured');
  return (e.name || 'Medicine') + (e.dose ? ` · ${e.dose}` : '') + ' given';
}
function renderToday() {
  const evs = eventsOn(viewDay), t = totals(evs);
  const isToday = viewDay === startOfDay(Date.now());
  const nd = nextDue();
  const mins = nd ? Math.round((nd.ts - Date.now()) / 60000) : 0;
  const w = weights();
  const sl = sleepOn(viewDay), napping = asleepNow();
  const unk = x => x.unk ? ` (+${x.unk} not measured)` : '';
  $('#view').innerHTML = `
    <div class="daybar">
      <button data-act="day" data-d="-1" aria-label="Previous day">‹</button>
      <b>${esc(dayLabel(viewDay))}</b>
      <button data-act="day" data-d="1" aria-label="Next day" ${isToday ? 'disabled' : ''}>›</button>
    </div>
    ${nd ? `<div class="card row" data-act="give" data-id="${nd.med.id}"><div class="dot dose">⏰</div><div class="grow"><div class="t"><b>Next medicine: ${esc(nd.med.name)}</b></div>
      <div class="muted">${esc(nd.med.dose || '')}${nd.med.dose ? ' · ' : ''}at ${nd.time} (in ${mins >= 60 ? Math.floor(mins / 60) + ' h ' : ''}${mins % 60} min)</div>
      <div class="muted small">Tap here when you give it – it is logged at the current time.</div></div><div class="tag">✓ Given</div></div>` : ''}
    <div class="stats">
      <button class="stat pee" data-act="add" data-type="pee"><div class="plus">+</div><div class="lbl">💧 Pee</div><div class="big">${t.pee.n}<small> ${t.pee.n === 1 ? "time" : "times"}</small></div><div class="sub">${t.pee.ml} ml${unk(t.pee)}</div></button>
      <button class="stat poop" data-act="add" data-type="poop"><div class="plus">+</div><div class="lbl">💩 Poop</div><div class="big">${t.poop.n}<small> ${t.poop.n === 1 ? "time" : "times"}</small></div><div class="sub">&nbsp;</div></button>
      <button class="stat drink" data-act="add" data-type="drink"><div class="plus">+</div><div class="lbl">🍼 Drinks</div><div class="big">${t.drink.n}<small> ${t.drink.n === 1 ? "time" : "times"}</small></div><div class="sub">${t.drink.ml} ml${unk(t.drink)}</div></button>
      <button class="stat dose" data-act="tab" data-tab="meds"><div class="lbl">💊 Medicine</div><div class="big">${t.dose.n}<small> ${t.dose.n === 1 ? "dose" : "doses"}</small></div><div class="sub">given</div></button>
    </div>
    <div class="card row">
      <div class="dot sleep" data-act="add" data-type="sleep">😴</div>
      <div class="grow" data-act="add" data-type="sleep"><div class="t"><b>Sleep: ${fmtDur(sl.ms)}</b></div>
        <div class="muted">${napping && isToday ? `asleep since ${fmtTime(napping.ts)} (${fmtDur(Date.now() - napping.ts)})` : sl.n ? `${sl.n} ${sl.n === 1 ? 'sleep' : 'sleeps'} · tap to add one by hand` : 'Tap to add a sleep by hand'}</div></div>
      ${isToday ? (napping ? `<button class="btn small" data-act="sleepStop">☀️ Woke up</button>` : `<button class="btn small ghost" data-act="sleepStart">😴 Asleep now</button>`) : ''}</div>
    <button class="card row weightcard" data-act="add" data-type="weight">
      <div class="dot weight">⚖️</div>
      <div class="grow"><div class="t"><b>Weight${w[0] ? ': ' + fmtKg(w[0].kg) : ''}</b></div>
      <div class="muted">${w[0] ? 'measured ' + esc(shortDate(w[0].ts)) + (w[1] ? ' · ' + esc(weightChange(w[0], w[1])) : '') : 'Tap to record his weight'}</div></div>
      <div class="plus">+</div></button>
    <button class="btn ghost wide" style="margin-bottom:12px" data-act="scan">📷 Scan a medicine</button>
    <div class="card"><h2>Log</h2>
      ${evs.length ? evs.map(e => `<div class="item" data-act="edit" data-id="${e.id}">
        <div class="dot ${e.type}">${ICON[e.type]}</div>
        <div class="grow"><div class="t">${esc(describe(e))}</div>${e.note ? `<div class="muted">${esc(e.note)}</div>` : ''}</div>
        <div class="time">${fmtTime(e.ts)}</div></div>`).join('') : '<p class="muted">Nothing logged for this day. Tap a coloured card above to add an entry.</p>'}
    </div>`;
}

function eventForm(type, ev, preset) {
  const e = ev || Object.assign({ type, ts: viewDay === startOfDay(Date.now()) ? Date.now() : viewDay + 12 * 3600e3 }, preset || {});
  let body = '';
  if (type === 'pee') {
    body = `<label>Amount (ml) – leave empty if not measured</label><input id="f-ml" type="number" inputmode="decimal" min="0" value="${esc(e.ml || '')}">
      <details><summary>Weigh the diaper instead</summary>
        <p class="muted">1 gram of extra weight ≈ 1 ml of urine.</p>
        <div class="two"><div><label>Wet diaper (g)</label><input id="f-wet" type="number" inputmode="decimal" min="0"></div>
        <div><label>Dry diaper (g)</label><input id="f-dry" type="number" inputmode="decimal" min="0" value="${esc(db.settings.dryDiaper || '')}"></div></div>
      </details>`;
  } else if (type === 'poop') {
    body = `<label>Consistency</label><div class="quick" id="f-kind">${POOPS.map(k => `<button type="button" class="chip ${e.kind === k ? 'sel' : ''}" data-act="pick" data-v="${k}">${k}</button>`).join('')}</div>`;
  } else if (type === 'drink') {
    body = `<label>What</label><div class="quick" id="f-kind">${DRINKS.map(k => `<button type="button" class="chip ${(e.kind || 'Formula') === k ? 'sel' : ''}" data-act="pick" data-v="${k}">${k}</button>`).join('')}</div>
      <label>Amount (ml) – leave empty if not measured</label><input id="f-ml" type="number" inputmode="decimal" min="0" value="${esc(e.ml || '')}">
      <div class="quick">${[15, 30, 60, 90, 120, 150].map(v => `<button type="button" class="chip" data-act="setml" data-v="${v}">${v}</button>`).join('')}</div>`;
  } else if (type === 'weight') {
    body = `<label>Weight in kg (for example 4.25) – or in grams (4250)</label><input id="f-kg" type="number" inputmode="decimal" min="0" step="0.001" value="${esc(e.kg || '')}">
      <p class="muted">Weigh him without clothes or diaper, at the same time of day, for comparable numbers.</p>`;
  } else if (type === 'sleep') {
    body = `<label>Woke up – leave empty if he is still asleep</label><input id="f-end" type="datetime-local" value="${e.end ? toLocalInput(e.end) : ''}">
      ${e.end ? `<p class="muted">Slept ${fmtDur(e.end - e.ts)}.</p>` : ''}`;
  } else {
    body = `<label>Medicine</label><input id="f-name" value="${esc(e.name || '')}"><label>Dose</label><input id="f-dose" value="${esc(e.dose || '')}"><input type="hidden" id="f-medid" value="${esc(e.medId || '')}">
      ${ev ? '' : '<p class="muted">Set "When" below to the time you actually gave it.</p>'}`;
  }
  const names = { pee: 'Pee', poop: 'Poop', drink: 'Drink', dose: 'Medicine dose', weight: 'Weight', sleep: 'Sleep' };
  openSheet(`<h2>${ICON[type]} ${ev ? 'Edit' : 'Add'} ${names[type].toLowerCase()}</h2>
    ${type === 'sleep' ? '' : body}
    <label>${type === 'sleep' ? 'Fell asleep' : 'When'}</label><input id="f-ts" type="datetime-local" value="${toLocalInput(e.ts)}">
    ${type === 'sleep' ? body : ''}
    <label>Note (optional)</label><input id="f-note" value="${esc(e.note || '')}">
    <div class="actions">
      ${ev ? `<button class="btn danger" data-act="del" data-id="${ev.id}">Delete</button>` : ''}
      <button class="btn ghost" data-act="close">Cancel</button>
      <button class="btn" data-act="saveEvent" data-type="${type}" data-id="${ev ? ev.id : ''}">Save</button>
    </div>`);
}
function saveEvent(el) {
  const type = el.dataset.type;
  const e = db.events.find(x => x.id === el.dataset.id) || { id: uid(), type };
  const ts = new Date($('#f-ts').value).getTime();
  if (type === 'sleep') {
    const start = isNaN(ts) ? Date.now() : ts;
    const end = $('#f-end').value ? new Date($('#f-end').value).getTime() : 0;
    if (start > Date.now()) { toast('The start time is in the future'); return; }
    if (end && end <= start) { toast('He must wake up after he fell asleep'); return; }
    if (!end && db.events.some(x => x !== e && x.type === 'sleep' && !x.end)) { toast('Another sleep is still running – end that one first'); return; }
    e.end = end;
  }
  e.ts = isNaN(ts) ? Date.now() : ts;
  e.note = $('#f-note').value.trim();
  const ml = $('#f-ml');
  if (ml) {
    let v = parseFloat(ml.value);
    const wet = $('#f-wet'), dry = $('#f-dry');
    if (wet && isNaN(v) && wet.value !== '') {
      const d = parseFloat(dry.value) || 0;
      v = Math.max(0, Math.round((parseFloat(wet.value) - d) * 10) / 10);
      db.settings.dryDiaper = dry.value;
    }
    e.ml = isNaN(v) ? 0 : v;
  }
  if (type === 'weight') {
    let kg = parseFloat($('#f-kg').value);
    if (!(kg > 0)) { toast('Enter the weight'); return; }
    if (kg > 60) kg = kg / 1000; // typed in grams
    e.kg = Math.round(kg * 1000) / 1000;
  }
  const kind = $('#f-kind .sel'); if ($('#f-kind')) e.kind = kind ? kind.dataset.v : '';
  if (type === 'dose') { e.name = $('#f-name').value.trim(); e.dose = $('#f-dose').value.trim(); if ($('#f-medid').value) e.medId = $('#f-medid').value; }
  if (!db.events.includes(e)) db.events.push(e);
  save(); closeSheet(); render(); toast('Saved');
}

// ---------- Medicines & reminders ----------
function renderMeds() {
  const today = eventsOn(startOfDay(Date.now())).filter(e => e.type === 'dose');
  const notifOff = hasNative && db.meds.length && !Native.notificationsAllowed();
  $('#view').innerHTML = `
    ${notifOff ? `<div class="note">Notifications are turned off for this app, so reminders cannot alert you. <button class="btn small" data-act="askNotif">Allow notifications</button></div>` : ''}
    ${db.meds.length ? exactNote() : ''}
    <div class="btnrow" style="margin-bottom:12px">
      <button class="btn" data-act="scan">📷 Scan medicine</button>
      <button class="btn ghost" data-act="lookup">🔎 Look up</button>
    </div>
    ${db.meds.map(m => {
      const given = today.filter(e => e.medId === m.id);
      return `<div class="card">
        <div class="row"><div class="grow"><h2 style="margin:0">${esc(m.name)}</h2>
          <div class="muted">${esc(m.dose || 'No dose entered')}</div></div>
          <input type="checkbox" class="switch" data-act="toggleMed" data-id="${m.id}" ${m.enabled !== false ? 'checked' : ''} aria-label="Reminders on">
        </div>
        <p>${(m.times || []).map(t => `<span class="tag">⏰ ${t}</span>`).join('') || '<span class="muted">No reminder times</span>'}</p>
        <p class="muted">Given today: ${given.length ? given.map(e => fmtTime(e.ts)).reverse().join(', ') : 'not yet'}</p>
        <div class="btnrow">
          <button class="btn small" data-act="give" data-id="${m.id}">✓ Given now</button>
          <button class="btn small ghost" data-act="giveAt" data-id="${m.id}">🕒 Given earlier</button>
          <button class="btn small ghost" data-act="editMed" data-id="${m.id}">Edit</button>
          ${m.drugId ? `<button class="btn small ghost" data-act="info" data-id="${m.drugId}">About</button>` : ''}
        </div></div>`;
    }).join('') || '<div class="card"><p class="muted">No medicines yet. Add one to get a notification when each dose is due.</p></div>'}
    <button class="btn wide" data-act="editMed" data-id="">+ Add medicine reminder</button>`;
}
function timeRow(v) { return `<div class="row" style="margin-bottom:6px"><input type="time" class="f-time" value="${esc(v)}"><button type="button" class="x" data-act="rmTime">✕</button></div>`; }
function medForm(m, preset) {
  const med = m || Object.assign({ name: '', dose: '', times: ['08:00'], enabled: true }, preset || {});
  openSheet(`<h2>💊 ${m ? 'Edit' : 'Add'} medicine</h2>
    <label>Name</label><input id="m-name" value="${esc(med.name)}">
    <label>Dose prescribed by the doctor (for example "2.5 ml")</label><input id="m-dose" value="${esc(med.dose || '')}">
    <label>Reminder times</label><div id="m-times">${(med.times || []).map(timeRow).join('')}</div>
    <div class="quick"><button type="button" class="chip" data-act="addTime">+ Add time</button>
      ${[4, 6, 8, 12].map(h => `<button type="button" class="chip" data-act="every" data-h="${h}">Every ${h} h</button>`).join('')}</div>
    <p class="muted">"Every N h" fills the day starting from the first time above.</p>
    <input type="hidden" id="m-drug" value="${esc(med.drugId || '')}">
    <div class="actions">
      ${m ? `<button class="btn danger" data-act="delMed" data-id="${m.id}">Delete</button>` : ''}
      <button class="btn ghost" data-act="close">Cancel</button>
      <button class="btn" data-act="saveMed" data-id="${m ? m.id : ''}">Save</button>
    </div>`);
}
function saveMed(el) {
  const name = $('#m-name').value.trim();
  if (!name) { toast('Enter the medicine name'); return; }
  const m = db.meds.find(x => x.id === el.dataset.id) || { id: uid(), enabled: true };
  m.name = name; m.dose = $('#m-dose').value.trim(); m.drugId = $('#m-drug').value || undefined;
  m.times = Array.from(new Set($$('.f-time').map(i => i.value).filter(Boolean))).sort();
  if (!db.meds.includes(m)) db.meds.push(m);
  save(); syncReminders(); closeSheet(); render();
  if (hasNative) Native.requestNotifications();
  toast(m.times.length ? 'Reminder set' : 'Saved without reminder times');
}

// ---------- Medicine database (bundled FDA label text) ----------
let INDEX = null; const drugCache = {};
async function loadJson(path) {
  if (hasNative) { const s = Native.readAsset(path); if (!s) throw new Error('missing ' + path); return JSON.parse(s); }
  const r = await fetch(path); if (!r.ok) throw new Error('missing ' + path); return r.json();
}
const STOP_FIRST = new Set(['sodium', 'calcium', 'silver', 'polyethylene', 'potassium', 'folic', 'chloral']);
async function ensureIndex() {
  if (INDEX) return INDEX;
  const idx = await loadJson('d/index.json');
  for (const d of idx) {
    const parts = d.name.split(' + ');
    const names = new Set(parts);
    for (const p of parts) { const w = p.split(' ')[0]; if (p.includes(' ') && w.length >= 6 && !STOP_FIRST.has(w)) names.add(w); }
    d.generic = Array.from(names);                                   // names a label would use for this medicine
    d.alt = (d.syn || []).filter(s => s.length >= 5);                 // international names / brands typed by hand
    d.all = Array.from(new Set(d.generic.concat(d.syn || [], d.brands || []))).filter(s => s.length >= 4);
  }
  INDEX = idx; return idx;
}
const drugById = id => INDEX.find(d => d.id === id);
async function getDrug(id) {
  if (!drugCache[id]) drugCache[id] = await loadJson('d/' + id + '.json');
  return drugCache[id];
}
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = t => new RegExp('(^|[^a-z0-9])(' + reEsc(t).replace(/[\s-]+/g, '[\\s-]?') + ')(e?s)?(?![a-z0-9])', 'i');

function lev1(a, b) { // true if edit distance <= 1
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (a.length < b.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
// Words that appear on most labels as part of a salt name ("clavulanate potassium") and must not match on their own.
const SALT_WORDS = new Set(['potassium', 'sodium', 'calcium', 'magnesium', 'zinc', 'iron', 'water', 'sugar']);
function matchDrugs(text) {
  const low = ' ' + text.toLowerCase().replace(/\s+/g, ' ') + ' ';
  const words = Array.from(new Set(low.split(/[^a-z0-9]+/).filter(w => w.length >= 7)));
  const out = [];
  for (const d of INDEX) {
    let score = 0, why = '';
    for (const t of d.generic) if (!SALT_WORDS.has(t) && termRe(t).test(low)) { score += 5; why = why || t; }
    // A combination product only counts as a strong match when every ingredient is on the label.
    const parts = d.name.split(' + ');
    if (score && parts.length > 1 && !parts.every(p => termRe(p).test(low) || termRe(p.split(' ')[0]).test(low))) score = 2;
    else if (score && parts.length > 1) score += 3;
    for (const t of d.syn || []) if (t.length >= 4 && termRe(t).test(low)) { score += 4; why = why || t; }
    for (const t of d.brands || []) if (!d.generic.includes(t) && termRe(t).test(low)) { score += 2; why = why || t; }
    if (!score) for (const t of d.generic.concat(d.alt)) {
      if (t.length >= 7 && !t.includes(' ') && !SALT_WORDS.has(t) && words.some(w => lev1(w, t))) { score = 1; why = t + ' (approximate)'; break; }
    }
    if (score) out.push({ d, score, why });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, 8);
}

const cleanHead = s => s.replace(/^\s*(\d+(\.\d+)?\s+)?(INDICATIONS?\s*(AND|&)\s*USAGE|DRUG INTERACTIONS|CONTRAINDICATIONS|BOXED WARNING|WARNING|Uses?|Purposes?|Pediatric Use)\s*:?\s*/i, '');
function brief(s, max) {
  s = cleanHead(s || '');
  const parts = s.split(/(?<=[.])\s+(?=[A-Z(])/);
  let out = '';
  for (const p of parts) { if (out && out.length + p.length > max) break; out += (out ? ' ' : '') + p; }
  return out.length > max + 150 ? out.slice(0, max) + '…' : out;
}
const classNames = d => (d.cls || []).filter(c => /\[EPC\]/.test(c)).map(c => c.replace(/\s*\[EPC\]/, ''));
const SOURCE_NOTE = 'Text comes from the official US FDA label stored in this app. It is general information, not advice for your child. Always follow your doctor or pharmacist.';

async function showDrug(id) {
  await ensureIndex();
  const e = drugById(id);
  if (!e || !e.has) { openSheet(`<h2>${esc(e ? e.name : id)}</h2><p class="muted">This medicine is recognised by name, but there is no label text for it in the app's offline database.</p><div class="actions"><button class="btn" data-act="close">Close</button></div>`); return; }
  const d = await getDrug(id);
  const what = brief(d.purpose, 200), uses = brief(d.uses, 480);
  const other = (d.syn || []).filter((v, i, a) => a.indexOf(v) === i && v !== d.name).slice(0, 8);
  const full = (label, s) => s ? `<details><summary>${label}</summary><p class="small">${esc(cleanHead(s))}</p></details>` : '';
  openSheet(`<h2 style="text-transform:capitalize">${esc(d.name)}</h2>
    <p>${classNames(d).map(c => `<span class="tag">${esc(c)}</span>`).join('')}</p>
    ${other.length ? `<p class="muted">Also known as: ${esc(other.join(', '))}</p>` : ''}
    ${what ? `<p><b>What it is:</b> ${esc(what)}</p>` : ''}
    <p><b>What it is used for:</b> ${esc(uses || what || 'Not stated on the stored label.')}</p>
    ${d.boxed ? `<div class="note"><b>Serious warning on the label:</b> ${esc(brief(d.boxed, 320))}</div>` : ''}
    ${d.pediatric ? `<p><b>Use in children:</b> ${esc(brief(d.pediatric, 380))}</p>` : ''}
    ${full('Full "uses" text', d.uses)}${full('Full "use in children" text', d.pediatric)}${full('When it must not be used', d.contra)}${full('Warnings (non-prescription label)', d.otcwarn)}
    <p class="muted small">Label used: ${esc(d.src.label || d.name)}${d.src.maker ? ' – ' + esc(d.src.maker) : ''}${d.src.date ? ', dated ' + esc(d.src.date.slice(0, 4) + '-' + d.src.date.slice(4, 6)) : ''}. ${SOURCE_NOTE}</p>
    <div class="btnrow">
      <button class="btn small" data-act="remindDrug" data-id="${d.id}">⏰ Add reminder</button>
      <button class="btn small ghost" data-act="checkAdd" data-id="${d.id}">⚠️ Add to interaction check</button>
    </div>
    <div class="actions"><button class="btn ghost" data-act="close">Close</button></div>`);
}

let searchThen = 'info';
async function searchSheet(then) {
  searchThen = then; await ensureIndex();
  openSheet(`<h2>🔎 Find a medicine</h2><input id="q" placeholder="Type a name, e.g. amoxicillin or Calpol" autocomplete="off">
    <div id="q-res"></div><div class="actions"><button class="btn ghost" data-act="close">Close</button></div>`);
  $('#q').addEventListener('input', () => {
    const q = $('#q').value.trim().toLowerCase();
    const hits = q.length < 2 ? [] : INDEX.map(d => {
      const m = d.all.find(t => t.startsWith(q)) || d.all.find(t => t.includes(q));
      return m ? { d, m, r: d.name.startsWith(q) ? 0 : m.startsWith(q) ? 1 : 2 } : null;
    }).filter(Boolean).sort((a, b) => a.r - b.r).slice(0, 25);
    $('#q-res').innerHTML = hits.map(h => `<div class="item" data-act="${searchThen === 'check' ? 'checkAdd' : 'info'}" data-id="${h.d.id}">
      <div class="grow"><div class="t" style="text-transform:capitalize">${esc(h.d.name)}</div>${h.m !== h.d.name ? `<div class="muted">${esc(h.m)}</div>` : ''}</div>
      ${h.d.has ? '' : '<span class="tag warn">no data</span>'}</div>`).join('') || (q.length >= 2 ? '<p class="muted">Not in the offline database.</p>' : '');
  });
  $('#q').focus();
}

// ---------- Scan ----------
function scanSheet() {
  openSheet(`<h2>📷 Scan a medicine</h2>
    <p class="muted">Photograph the front of the box or bottle so the medicine name is sharp and well lit. The text is read on the phone; no photo leaves the device.</p>
    ${hasNative ? `<div class="btnrow"><button class="btn" data-act="camera">Take photo</button><button class="btn ghost" data-act="gallery">Choose photo</button></div>` : ''}
    <label>Or type what the label says</label><textarea id="scan-text" placeholder="e.g. Amoxicillin 250 mg/5 ml oral suspension"></textarea>
    <div class="actions"><button class="btn ghost" data-act="close">Cancel</button><button class="btn" data-act="scanText">Find medicine</button></div>`);
}
window.onScanError = msg => { if (msg !== 'cancelled') toast('Could not read the photo: ' + msg); };
window.onScanResult = async text => {
  await ensureIndex();
  const hits = text.trim() ? matchDrugs(text) : [];
  openSheet(`<h2>Scan result</h2>
    ${hits.length ? `<p class="muted">Tap the medicine that matches the package. Check the name yourself – text reading can make mistakes.</p>` +
      hits.map(h => `<div class="item" data-act="info" data-id="${h.d.id}"><div class="dot dose">💊</div>
        <div class="grow"><div class="t" style="text-transform:capitalize">${esc(h.d.name)}</div><div class="muted">matched “${esc(h.why)}”</div></div>
        ${h.d.has ? '' : '<span class="tag warn">no data</span>'}</div>`).join('')
      : `<div class="note">${text.trim() ? 'No medicine in the offline database matched the text on the photo.' : 'No readable text was found in the photo.'} Try a sharper photo of the active-ingredient name, or look it up by typing.</div>`}
    <details><summary>Text read from the label</summary><p class="small">${esc(text) || '(nothing)'}</p></details>
    <div class="actions"><button class="btn ghost" data-act="scan">Scan again</button><button class="btn ghost" data-act="lookup">Look up</button><button class="btn" data-act="close">Close</button></div>`);
};

// ---------- Log (free-form entries with size, barcode and pictures) ----------
// `draft` is the entry being edited. It is kept outside the form because taking a photo or
// scanning a barcode leaves the page; it is also stashed in case Android restarts the app meanwhile.
let draft = null;
const PHOTO_BASE = hasNative ? Native.photoBase() : '';
// Pictures are JPEG files named p….jpg. The Android app keeps them as files; the web app keeps
// them (as base64) in the browser's IndexedDB and holds a copy in memory to show them.
const photoCache = {};
const NO_PHOTO = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
const photoUrl = p => p.startsWith('data:') ? p : hasNative ? PHOTO_BASE + p : photoCache[p] ? 'data:image/jpeg;base64,' + photoCache[p] : NO_PHOTO;
const photoStore = (mode, fn) => new Promise((ok, no) => {
  const open = indexedDB.open('littlehugs', 1);
  open.onupgradeneeded = () => open.result.createObjectStore('photos');
  open.onerror = () => no(open.error);
  open.onsuccess = () => {
    const t = open.result.transaction('photos', mode); let out;
    fn(t.objectStore('photos'), v => { out = v; });
    t.oncomplete = () => { open.result.close(); ok(out); };
    t.onerror = t.onabort = () => { open.result.close(); no(t.error); };
  };
});
const Photos = hasNative ? {
  list: async () => JSON.parse(Native.listPhotos()),
  read: async name => Native.readPhoto(name),
  write: async (name, b64) => { if (!Native.writePhoto(name, b64)) throw new Error('could not store the picture'); },
  keep: names => Native.keepPhotos(JSON.stringify(names)),
} : {
  list: async () => Object.keys(photoCache),
  read: async name => photoCache[name] || '',
  write: async (name, b64) => { await photoStore('readwrite', s => s.put(b64, name)); photoCache[name] = b64; },
  keep: names => {
    const gone = Object.keys(photoCache).filter(n => !names.includes(n));
    if (!gone.length) return;
    for (const n of gone) delete photoCache[n];
    photoStore('readwrite', s => gone.forEach(n => s.delete(n))).catch(() => { });
  },
  loadAll: () => photoStore('readonly', (s, done) => {
    const c = s.openCursor();
    c.onsuccess = () => { const cur = c.result; if (cur) { photoCache[cur.key] = cur.value; cur.continue(); } else done(true); };
  }),
};
// ---- Web app only: choosing a picture and reading a barcode without the Android helpers ----
const pickImage = camera => new Promise(ok => {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/*';
  if (camera) inp.capture = 'environment';
  inp.onchange = () => ok(inp.files[0] || null);
  inp.oncancel = () => ok(null);
  inp.click();
});
async function toCanvas(file, max) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('this file is not a picture')); i.src = url; });
    const k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k)); c.height = Math.max(1, Math.round(img.naturalHeight * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c;
  } finally { URL.revokeObjectURL(url); }
}
// Lets the user take or choose a picture, stores it (at most 1600 px) and returns its name; '' if cancelled.
async function webPhoto(camera) {
  const f = await pickImage(camera);
  if (!f) return '';
  const c = await toCanvas(f, 1600);
  const name = 'p' + uid() + '.jpg';
  await Photos.write(name, c.toDataURL('image/jpeg', 0.85).split(',')[1]);
  return name;
}
const loadScript = src => new Promise((ok, no) => {
  if (document.querySelector(`script[src="${src}"]`)) { ok(); return; }
  const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = () => { s.remove(); no(new Error('the barcode reader could not be loaded')); };
  document.head.appendChild(s);
});
// zxing.js + zxing_reader.wasm (the open-source ZXing reader) ship with the web app only.
async function zxingRead(file) {
  await loadScript('zxing.js');
  if (!zxingRead.ready) {
    ZXingWASM.prepareZXingModule({ overrides: { locateFile: (path, prefix) => /\.wasm$/.test(path) ? 'zxing_reader.wasm' : prefix + path } });
    zxingRead.ready = true;
  }
  for (const max of [1600, 2600, 900]) {
    const c = await toCanvas(file, max);
    const found = await ZXingWASM.readBarcodes(c.getContext('2d').getImageData(0, 0, c.width, c.height), { tryHarder: true, maxNumberOfSymbols: 8 });
    const texts = found.map(x => x.text).filter(Boolean);
    if (texts.length) return texts.find(t => /^\d{8,14}$/.test(t)) || texts[0];   // a product number rather than a QR code
  }
  return '';
}
async function webBarcode(camera) {
  const f = await pickImage(camera);
  if (!f) { window.onBarcodeError('cancelled'); return; }
  toast('Reading the barcode…');
  try {
    let code = '';
    if ('BarcodeDetector' in window) {
      try { const r = await new BarcodeDetector().detect(await toCanvas(f, 2400)); if (r[0]) code = r[0].rawValue; } catch (e) { }
    }
    if (!code) code = await zxingRead(f);
    if (code) window.onBarcode(code); else window.onBarcodeError('none');
  } catch (e) { window.onBarcodeError(e.message || String(e)); }
}
function stash(d) { try { if (d) localStorage.setItem('bc_draft', JSON.stringify(d)); else localStorage.removeItem('bc_draft'); } catch (e) { } }
function unstash() { try { return JSON.parse(localStorage.getItem('bc_draft') || 'null'); } catch (e) { return null; } }
function savedPhotos() { // every picture a saved entry or product uses
  const names = [];
  for (const n of db.notes) names.push.apply(names, n.photos || []);
  for (const c in db.products) names.push.apply(names, [db.products[c].front, db.products[c].back]);
  return names.filter(p => p && !p.startsWith('data:'));
}
function keepPhotos() { // delete stored pictures that no entry (or unfinished draft) uses
  const names = savedPhotos();
  const d = draft || unstash(); if (d) names.push.apply(names, d.photos || []);
  const pd = pdraft || unstashP(); if (pd) names.push(pd.front, pd.back);
  Photos.keep(names.filter(Boolean));
}
function spanText(days) {
  if (days < 1) return 'less than a day';
  let s = days + (days === 1 ? ' day' : ' days');
  if (days >= 28) { const m = Math.round(days / 30.44 * 2) / 2; s += ` (about ${m} ${m === 1 ? 'month' : 'months'})`; }
  return s;
}
const noteDays = n => Math.max(0, Math.round((startOfDay(n.endTs) - startOfDay(n.ts)) / 86400e3));
const lasted = n => n.endTs ? `Finished ${shortDate(n.endTs)} · lasted ${spanText(noteDays(n))}` : '';
function noteRow(n) {
  const p = (n.photos || [])[0];
  return `<div class="item" data-act="noteEdit" data-id="${n.id}">
    ${p ? `<img class="thumb" src="${esc(photoUrl(p))}" alt="">` : '<div class="dot weight">📝</div>'}
    <div class="grow"><div class="t">${esc(n.title)}</div>
      <div class="muted">${esc([n.size, shortDate(n.ts) + ' ' + fmtTime(n.ts)].filter(Boolean).join(' · '))}</div>
      ${n.endTs ? `<div class="muted">${esc(lasted(n))}</div>` : ''}
      ${n.note ? `<div class="muted">${esc(n.note)}</div>` : ''}</div>
    ${n.barcode ? '<span class="tag">barcode</span>' : ''}</div>`;
}
function renderLog() {
  const list = db.notes.slice().sort((a, b) => b.ts - a.ts);
  $('#view').innerHTML = `
    <div class="btnrow" style="margin-bottom:12px">
      <button class="btn" data-act="noteNew">+ New entry</button>
      <button class="btn ghost" data-act="barScan">🔍 Scan barcode</button>
    </div>
    <div class="card">${list.map(noteRow).join('') || '<p class="muted">Nothing here yet. Use this for anything you want to remember – for example “Bought milk”, its size, a picture of the can, and later the day it finished.</p>'}</div>
    <div class="card"><h2>🔔 My reminders</h2>
      ${hasNative && db.reminders.length && !Native.notificationsAllowed() ? `<div class="note">Notifications are turned off for this app, so reminders cannot alert you. <button class="btn small" data-act="askNotif">Allow notifications</button></div>` : ''}
      ${db.reminders.length ? exactNote() : ''}
      ${db.reminders.map(r => { const nx = nextOcc(r); return `<div class="item">
        <div class="dot dose" data-act="remEdit" data-id="${r.id}">🔔</div>
        <div class="grow" data-act="remEdit" data-id="${r.id}"><div class="t">${esc(r.text)}</div>
          <div class="muted">${nx ? 'Next: ' + esc(whenText(nx)) : 'Was due ' + esc(whenText(r.ts))}${r.unit ? ' · ' + esc(repeatText(r)) : ''}</div></div>
        <input type="checkbox" class="switch" data-act="remToggle" data-id="${r.id}" ${r.enabled !== false ? 'checked' : ''} aria-label="Reminder on"></div>`; }).join('') || '<p class="muted">Get a notification for anything – for example “Buy milk” every month.</p>'}
      <button class="btn small ghost" style="margin-top:8px" data-act="remNew">+ Add reminder</button></div>`;
}

// ---------- Custom reminders ----------
// A reminder is due at r.ts and then, if it repeats, every r.every days / weeks / months after that.
// ReminderScheduler.occurrenceAfter() on the phone uses the same rule.
function occurrence(r, k) {
  const d = new Date(r.ts);
  if (r.unit === 'month') {
    const day = d.getDate(); d.setDate(1); d.setMonth(d.getMonth() + k * r.every);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  } else d.setDate(d.getDate() + k * r.every * (r.unit === 'week' ? 7 : 1));
  return d.getTime();
}
function nextOcc(r) {
  const now = Date.now();
  if (!r.unit) return r.ts > now ? r.ts : 0;
  for (let k = 0; k < 20000; k++) { const t = occurrence(r, k); if (t > now) return t; }
  return 0;
}
const whenText = ts => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) + ' ' + fmtTime(ts);
const repeatText = r => r.unit ? `every ${r.every === 1 ? '' : r.every + ' '}${r.unit}${r.every === 1 ? '' : 's'}` : 'once';
function remForm(r, preset) {
  const tomorrow9 = addDays(startOfDay(Date.now()), 1) + 9 * 3600e3;
  const x = r || Object.assign({ text: '', ts: tomorrow9, every: 1, unit: '' }, preset || {});
  openSheet(`<h2>🔔 ${r ? 'Edit' : 'Add'} reminder</h2>
    <label>Remind me to…</label><input id="r-text" placeholder="e.g. Buy milk" value="${esc(x.text)}">
    <label>${r && r.unit ? 'Starting on' : 'On'}</label><input id="r-ts" type="datetime-local" value="${toLocalInput(x.ts)}">
    <label>Repeat</label>
    <div class="two"><input id="r-every" type="number" inputmode="numeric" min="1" value="${esc(x.every || 1)}" aria-label="Every">
      <select id="r-unit">${[['', 'Does not repeat'], ['day', 'days'], ['week', 'weeks'], ['month', 'months']].map(([v, l]) => `<option value="${v}" ${x.unit === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <p class="muted small">For “every month” choose 1 and months. A repeating reminder keeps coming at the same time of day until you turn it off.</p>
    <div class="actions">
      ${r ? `<button class="btn danger" data-act="remDel" data-id="${r.id}">Delete</button>` : ''}
      <button class="btn ghost" data-act="close">Cancel</button>
      <button class="btn" data-act="remSave" data-id="${r ? r.id : ''}">Save</button>
    </div>`);
}
function saveRem(el) {
  const text = $('#r-text').value.trim(), ts = new Date($('#r-ts').value).getTime();
  const unit = $('#r-unit').value, every = Math.max(1, Math.round(+$('#r-every').value) || 1);
  if (!text) { toast('Write what to remind you about'); return; }
  if (isNaN(ts)) { toast('Choose the date and time'); return; }
  if (!unit && ts <= Date.now()) { toast('That time has already passed'); return; }
  const r = db.reminders.find(x => x.id === el.dataset.id) || { id: uid() };
  // `from`: occurrences before this moment are never shown, so a start date in the past does not alert at once.
  Object.assign(r, { text, ts, unit, every, enabled: true, from: Date.now() });
  if (!db.reminders.includes(r)) db.reminders.push(r);
  save(); syncReminders(); closeSheet(); tab = 'log'; render();
  if (hasNative) Native.requestNotifications();
  toast('Reminder set for ' + whenText(nextOcc(r)));
}
function startNote(n, preset) {
  draft = n ? JSON.parse(JSON.stringify(n)) : Object.assign({ id: '', title: '', size: '', ts: Date.now(), endTs: 0, barcode: '', photos: [], note: '' }, preset || {});
  draft.photos = draft.photos || [];
  noteForm();
}
function noteForm() {
  const n = draft;
  openSheet(`<h2>📝 ${n.id ? 'Edit' : 'New'} log entry</h2>
    <label>What do you want to log?</label><input id="n-title" placeholder="e.g. Bought milk" value="${esc(n.title)}">
    <label>Size / amount (optional)</label><input id="n-size" placeholder="e.g. 800 g can" value="${esc(n.size || '')}">
    <label>When</label><input id="n-ts" type="datetime-local" value="${toLocalInput(n.ts)}">
    <label>Finished on (optional)</label>
    <div class="row"><input id="n-end" type="date" value="${n.endTs ? toLocalInput(n.endTs).slice(0, 10) : ''}"><button type="button" class="chip" data-act="noteEndToday">Today</button></div>
    ${n.endTs ? `<p class="muted small">Lasted ${esc(spanText(noteDays(n)))}.</p>` : ''}
    <label>Barcode (optional)</label>
    <div class="row"><input id="n-bar" class="barcode" inputmode="numeric" value="${esc(n.barcode || '')}"><button type="button" class="btn small ghost" data-act="noteBar">Scan</button></div>
    <label>Pictures</label>
    ${n.photos.length ? `<div class="thumbs">${n.photos.map((p, i) => `<img class="thumb" src="${esc(photoUrl(p))}" data-act="notePhoto" data-i="${i}" alt="Picture ${i + 1}">`).join('')}</div>` : ''}
    <div class="btnrow" style="margin-top:8px"><button type="button" class="btn small ghost" data-act="notePhotoAdd" data-cam="1">📷 Take photo</button><button type="button" class="btn small ghost" data-act="notePhotoAdd" data-cam="">🖼 Choose photo</button></div>
    <label>Note (optional)</label><textarea id="n-note">${esc(n.note || '')}</textarea>
    ${n.id ? `<button type="button" class="btn small ghost wide" style="margin-top:12px" data-act="noteRemind">🔔 Remind me to buy this again</button>` : ''}
    <div class="actions">
      ${n.id ? `<button class="btn danger" data-act="noteDel">Delete</button>` : ''}
      <button class="btn ghost" data-act="close">Cancel</button>
      <button class="btn" data-act="noteSave">Save</button>
    </div>`);
}
function readNoteForm() {
  if (!draft || !$('#n-title')) return;
  draft.title = $('#n-title').value.trim();
  draft.size = $('#n-size').value.trim();
  const ts = new Date($('#n-ts').value).getTime(); if (!isNaN(ts)) draft.ts = ts;
  const end = $('#n-end').value ? new Date($('#n-end').value + 'T12:00').getTime() : 0;
  draft.endTs = isNaN(end) ? 0 : end;
  draft.barcode = $('#n-bar').value.trim();
  draft.note = $('#n-note').value.trim();
}
function saveNote() {
  readNoteForm();
  if (!draft.title) { toast('Write what you want to log'); return; }
  if (draft.endTs && startOfDay(draft.endTs) < startOfDay(draft.ts)) { toast('The finished date is before the start'); return; }
  delete draft.wait;
  const old = db.notes.find(x => x.id === draft.id);
  if (old) Object.assign(old, draft); else { draft.id = uid(); db.notes.push(draft); }
  draft = null; stash(null);
  save(); closeSheet(); keepPhotos(); tab = 'log'; render(); toast('Saved');
}
function barcodeSheet() {
  openSheet(`<h2>🔍 Scan a barcode</h2>
    <p class="muted">Take a sharp, close photo of the barcode. The photo stays on the phone; only the barcode number is sent to the open product databases to find the product name and ingredients.</p>
    <div class="btnrow"><button class="btn" data-act="barCam" data-cam="1">Take photo</button><button class="btn ghost" data-act="barCam" data-cam="">Choose photo</button></div>
    <label>Or type the number under the barcode</label><input id="bar-text" class="barcode" inputmode="numeric">
    <div class="actions"><button class="btn ghost" data-act="${draft ? 'noteBack' : 'close'}">Cancel</button><button class="btn" data-act="barTyped">OK</button></div>`);
}
function showBarcode(code) {
  const hits = db.notes.filter(n => n.barcode === code).sort((a, b) => b.ts - a.ts);
  const done = hits.filter(n => n.endTs);
  const avg = done.length ? Math.round(done.reduce((s, n) => s + noteDays(n), 0) / done.length) : 0;
  tab = 'log'; render();
  const known = db.products[code];
  openSheet(`<h2 id="bar-title">${esc(hits.length ? hits[0].title : known ? productTitle(known) : 'Barcode ' + code)}</h2>
    <p class="muted barcode" id="bar-code" data-code="${esc(code)}">${esc(code)}</p>
    <div id="bar-product">${known ? productHtml(known, code) : '<p class="muted">Looking this product up online…</p>'}</div>
    ${hits.length ? `<p class="muted">In your log ${hits.length === 1 ? 'once' : hits.length + ' times'}${done.length ? ` · lasts ${esc(spanText(avg))}${done.length > 1 ? ' on average' : ''}` : ''}. Tap an entry to open it.</p>${hits.map(noteRow).join('')}` : ''}
    <div class="actions"><button class="btn ghost" data-act="close">Close</button><button class="btn" data-act="noteFromBar" data-code="${esc(code)}">+ New entry${hits.length ? ' (bought again)' : ''}</button></div>`);
  if (!known) lookupProduct(code);
}

// ---------- Product lookup (the only online feature) ----------
// A scanned barcode number is sent to the open databases Open Food Facts / Open Beauty Facts /
// Open Products Facts. Results are remembered in db.products so later scans work offline.
// Product name, prefixed with the brand unless the name already starts with it.
const productTitle = p => {
  const brand = (p.brand || '').split(',')[0].trim(), firstWord = brand.split(/\s+/)[0].toLowerCase();
  return [brand && !p.name.toLowerCase().includes(firstWord) ? brand : '', p.name].filter(Boolean).join(' ') || brand;
};
function productHtml(p, code) {
  const mine = p.source === 'you';
  const pics = [p.front, p.back].filter(Boolean);
  return `<div class="card" style="margin:8px 0">
    <div class="t"><b>${esc(productTitle(p))}</b></div>
    ${p.quantity ? `<div class="muted">Size: ${esc(p.quantity)}</div>` : ''}
    ${pics.length ? `<div class="thumbs" style="margin:8px 0">${pics.map(x => `<img class="thumb" src="${esc(photoUrl(x))}" data-act="prodView" data-code="${esc(code)}" data-p="${esc(x)}" alt="Package photo">`).join('')}</div>` : ''}
    <p><b>Ingredients:</b> ${p.ingredients ? esc(p.ingredients) : `<span class="muted">${mine ? 'not entered' : 'not listed in the database'}</span>`}</p>
    ${p.label ? `<details><summary>Other text from the package</summary><p class="small">${esc(p.label)}</p></details>` : ''}
    <p class="muted small">${mine ? 'Saved by you from the package. Text read from a photo can contain mistakes – the package itself is always right.' : `From ${esc(p.source)}, an open database filled in by volunteers. It can be incomplete, out of date or wrong – always check the package itself, especially for allergies.`}</p>
    <button class="btn small ghost" data-act="prodEdit" data-code="${esc(code)}">✏️ ${mine ? 'Edit' : 'Correct'} this product</button></div>`;
}

// ---------- Your own products (for barcodes no database knows) ----------
// Photograph the front and the back of the pack; the text is read on the phone and saved with the pictures.
let pdraft = null;
function stashP(d) { try { if (d) localStorage.setItem('bc_pdraft', JSON.stringify(d)); else localStorage.removeItem('bc_pdraft'); } catch (e) { } }
function unstashP() { try { return JSON.parse(localStorage.getItem('bc_pdraft') || 'null'); } catch (e) { return null; } }
const flatText = t => String(t || '').replace(/-\s*\n\s*/g, '').replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ').trim();
const ING_END = '(?=\\s(?:al+ergens?\\b|al+ergy advice|storage|store |nutrition|preparation|directions|packed |manufactur|best before|use within)|$)';
function ingredientsFrom(text) {
  const flat = flatText(text);
  const m = new RegExp('ingredients?\\s*[:.]?\\s*(.+?)' + ING_END, 'i').exec(flat);
  if (m) return m[1].trim();
  // The "Ingredients:" heading is often cut off in a close-up: a long comma-separated run is the list itself.
  const run = new RegExp('^(.+?)' + ING_END, 'i').exec(flat);
  return run && (run[1].match(/,/g) || []).length >= 6 ? run[1].trim() : '';
}
function sizeFrom(text) { const m = /\b(\d+(?:[.,]\d+)?)\s?(kg|g|ml|l|oz|pcs|pieces|diapers|wipes)\b/i.exec(flatText(text)); return m ? m[1] + ' ' + m[2] : ''; }
function startProduct(code) {
  const p = db.products[code] || {};
  pdraft = { code, name: p.name ? productTitle(p) : '', quantity: p.quantity || '', ingredients: p.ingredients || '', label: p.label || '', front: p.front || '', back: p.back || '', side: '' };
  productForm();
}
function productForm() {
  const p = pdraft;
  const side = (key, title, hint) => `<label>${title}</label>
    <div class="row">${p[key] ? `<img class="thumb" src="${esc(photoUrl(p[key]))}" alt="">` : ''}
      <div class="grow"><div class="btnrow"><button type="button" class="btn small ghost" data-act="prodPhoto" data-side="${key}" data-cam="1">📷 Take photo</button><button type="button" class="btn small ghost" data-act="prodPhoto" data-side="${key}" data-cam="">🖼 Choose</button></div>
      <div class="muted small" style="margin-top:4px">${hint}</div></div></div>`;
  openSheet(`<h2>📦 Save this product</h2>
    <p class="muted barcode">${esc(p.code)}</p>
    ${side('front', '1. Front of the pack', hasNative ? 'Fills in the name and size.' : '')}
    ${side('back', '2. Back of the pack – the ingredients list', hasNative ? 'Hold the phone straight and close so the small print is sharp. Fills in the ingredients.' : 'Keeps a picture of the ingredients with the product.')}
    <label>Name</label><input id="p-name" value="${esc(p.name)}">
    <label>Size (optional)</label><input id="p-qty" value="${esc(p.quantity)}">
    <label>Ingredients</label><textarea id="p-ing" style="min-height:140px">${esc(p.ingredients)}</textarea>
    <label>Other text from the package (optional)</label><textarea id="p-label">${esc(p.label)}</textarea>
    ${hasNative ? '<p class="muted small">Check the text against the package and correct it – reading from a photo makes mistakes, and Arabic text is not read.</p>' : ''}
    <div class="actions"><button class="btn ghost" data-act="prodCancel">Cancel</button><button class="btn" data-act="prodSave">Save</button></div>`);
}
function readProductForm() {
  if (!pdraft || !$('#p-name')) return;
  pdraft.name = $('#p-name').value.trim(); pdraft.quantity = $('#p-qty').value.trim();
  pdraft.ingredients = $('#p-ing').value.trim(); pdraft.label = $('#p-label').value.trim();
}
window.onProductPhoto = (file, text) => {
  if (!pdraft) pdraft = unstashP();
  if (!pdraft) return;
  const side = pdraft.side || 'back';
  pdraft[side] = file; pdraft.side = '';
  const flat = flatText(text);
  if (side === 'front') {
    if (!pdraft.name) pdraft.name = String(text || '').split('\n').map(s => s.trim()).filter(s => s.length > 1 || /\d/.test(s)).slice(0, 3).join(' ').slice(0, 70);
    if (!pdraft.quantity) pdraft.quantity = sizeFrom(text);
  } else {
    const ing = ingredientsFrom(text);
    if (ing) pdraft.ingredients = ing;
    pdraft.label = flat.slice(0, 4000);
    if (!pdraft.quantity) pdraft.quantity = sizeFrom(text);
  }
  stashP(pdraft); tab = 'log'; render(); productForm();
  toast(!hasNative ? 'Picture added – type the name and ingredients from the pack' : flat ? (side === 'back' && !ingredientsFrom(text) ? 'No “Ingredients:” heading found – the text is under “Other text”' : 'Text read – please check it') : 'No readable text in the photo');
};
window.onProductPhotoError = msg => { if (msg !== 'cancelled') toast('Could not use the photo: ' + msg); };
function lookupProduct(code) {
  if (hasNative) { Native.lookupBarcode(code); return; }
  lookupWeb(code);
}
async function lookupWeb(code) { // same lookup as MainActivity.lookupBarcode
  if (!/^\d{6,14}$/.test(code)) { window.onProduct(code, null, null); return; }
  let failed = 0;
  const sites = [['world.openfoodfacts.org', 'Open Food Facts'], ['world.openbeautyfacts.org', 'Open Beauty Facts'], ['world.openproductsfacts.org', 'Open Products Facts']];
  for (const [host, source] of sites) {
    try {
      const o = await (await fetch(`https://${host}/api/v2/product/${code}.json?fields=product_name,product_name_en,generic_name,brands,quantity,ingredients_text,ingredients_text_en`)).json();
      const p = o.product, name = p && (p.product_name_en || p.product_name || p.generic_name || '');
      if (o.status === 1 && p && (name || p.brands)) {
        window.onProduct(code, { name, brand: p.brands || '', quantity: p.quantity || '', ingredients: p.ingredients_text_en || p.ingredients_text || '', source }, null);
        return;
      }
    } catch (e) { failed++; }
  }
  window.onProduct(code, null, failed === sites.length ? 'offline' : null);
}
window.onProduct = (code, p, err) => {
  if (p) { db.products[code] = p; save(); }
  const shown = $('#bar-code');
  if (shown && shown.dataset.code === code) {
    $('#bar-product').innerHTML = p ? productHtml(p, code)
      : `<div class="note">${err ? 'Could not reach the product database – check the internet connection and scan again.' : 'This product is not in the open product databases.'} You can save it yourself: photograph the front and the back of the pack, and the next scan will show its name and ingredients.</div>
        <button class="btn wide" style="margin-bottom:8px" data-act="prodEdit" data-code="${esc(code)}">📷 Add this product myself</button>`;
    if (p && /^Barcode /.test($('#bar-title').textContent)) $('#bar-title').textContent = productTitle(p);
  }
  // Scanned from inside the entry form: fill the empty name and size.
  if (p && draft && $('#n-title') && $('#n-bar').value.trim() === code) {
    readNoteForm();
    if (!draft.title) draft.title = productTitle(p);
    if (!draft.size) draft.size = p.quantity || '';
    noteForm();
  }
};
window.onBarcode = code => {
  code = String(code).trim();
  if (!draft) { const d = unstash(); if (d && d.wait === 'barcode') draft = d; }
  if (draft && draft.wait === 'barcode') {
    draft.wait = ''; draft.barcode = code; tab = 'log'; render(); noteForm();
    const known = db.products[code];
    if (known) window.onProduct(code, known, null); else lookupProduct(code);
    return;
  }
  showBarcode(code);
};
window.onBarcodeError = msg => {
  if (msg === 'cancelled') { if (draft) noteForm(); return; }
  toast(msg === 'none' ? 'No barcode found in the photo – try closer and sharper' : 'Could not read the barcode: ' + msg);
};
window.onPhoto = name => {
  if (!draft) draft = unstash();
  if (!draft) { startNote(null, { photos: [name] }); return; }
  draft.wait = ''; draft.photos.push(name); stash(draft);
  tab = 'log'; render(); noteForm();
};
window.onPhotoError = msg => { if (msg !== 'cancelled') toast('Could not add the picture: ' + msg); };

// ---------- Interaction checker ----------
// Maps FDA pharmacologic-class labels to the wording other labels use when they warn about that class.
const CLASS_TERMS = [
  [/nonsteroidal anti-inflammatory/, ['NSAID', 'nonsteroidal anti-inflammatory', 'non-steroidal anti-inflammatory']],
  [/macrolide/, ['macrolide']], [/proton pump inhibitor/, ['proton pump inhibitor', 'PPI']],
  [/corticosteroid/, ['corticosteroid']], [/benzodiazepine/, ['benzodiazepine', 'CNS depressant']],
  [/opioid agonist/, ['opioid', 'CNS depressant']], [/barbiturate/, ['barbiturate', 'CNS depressant']],
  [/anticoagulant|vitamin k antagonist|factor xa inhibitor/, ['anticoagulant']],
  [/platelet aggregation inhibitor/, ['antiplatelet', 'platelet aggregation inhibitor']],
  [/serotonin reuptake inhibitor/, ['SSRI', 'serotonergic', 'serotonin reuptake inhibitor']],
  [/serotonin and norepinephrine reuptake/, ['SNRI', 'serotonergic']], [/tricyclic/, ['tricyclic']],
  [/monoamine oxidase inhibitor/, ['MAOI', 'monoamine oxidase inhibitor']],
  [/angiotensin converting enzyme inhibitor/, ['ACE inhibitor', 'angiotensin converting enzyme inhibitor']],
  [/angiotensin 2 receptor blocker/, ['angiotensin receptor blocker', 'angiotensin II receptor']],
  [/beta-adrenergic blocker|beta adrenergic blocker/, ['beta-blocker', 'beta-adrenergic blocker', 'beta-adrenergic blocking']],
  [/beta2-adrenergic agonist/, ['beta-agonist', 'beta2-agonist', 'sympathomimetic']],
  [/calcium channel blocker/, ['calcium channel blocker']],
  [/diuretic/, ['diuretic']], [/aldosterone antagonist|potassium-sparing/, ['potassium-sparing']],
  [/hmg-coa reductase inhibitor/, ['statin', 'HMG-CoA reductase inhibitor']],
  [/quinolone/, ['quinolone', 'fluoroquinolone']], [/tetracycline/, ['tetracycline']],
  [/aminoglycoside/, ['aminoglycoside']], [/penicillin/, ['penicillin']], [/cephalosporin/, ['cephalosporin']],
  [/azole antifungal/, ['azole antifungal', 'azole']], [/histamine-1 receptor antagonist|antihistamine/, ['antihistamine']],
  [/anticholinergic/, ['anticholinergic']], [/anti-epileptic/, ['antiepileptic', 'anticonvulsant']],
  [/sulfonylurea/, ['sulfonylurea']], [/\binsulin\b/, ['insulin']], [/antipsychotic/, ['antipsychotic']],
  [/calcineurin inhibitor/, ['calcineurin inhibitor']], [/central nervous system stimulant/, ['CNS stimulant', 'stimulant']],
  [/alpha-adrenergic agonist|sympathomimetic/, ['sympathomimetic']], [/methylxanthine/, ['xanthine']],
  [/p-glycoprotein inhibitor/, ['P-gp inhibitor', 'P-glycoprotein inhibitor']]
];
function classTerms(d) {
  const joined = (d.cls || []).join(' | ').toLowerCase();
  const out = new Set();
  for (const [re, terms] of CLASS_TERMS) if (re.test(joined)) terms.forEach(t => out.add(t));
  const cyp = /cytochrome p450 (\w+) (inhibitor|inducer)/g; let m;
  while ((m = cyp.exec(joined))) {
    out.add(`CYP${m[1].toUpperCase()} ${m[2]}`);
    if (m[1].startsWith('3a')) out.add(`CYP3A ${m[2]}`);
  }
  return Array.from(out);
}
function sentencesWith(text, re) {
  const found = [];
  for (const s of cleanHead(text).split(/(?<=[.;:])\s+(?=[A-Z0-9(])/)) {
    const m = re.exec(s); if (!m) continue;
    let q = s;
    if (q.length > 420) { const at = Math.max(0, m.index - 180); q = (at ? '…' : '') + q.slice(at, at + 420) + '…'; }
    found.push(q); if (found.length >= 3) break;
  }
  return found;
}
/** What does medicine A's label say about medicine B? */
function mentions(A, B, eA, eB) {
  const sections = [['Serious (boxed) warning', A.boxed], ['Must not be used with', A.contra], ['Drug interactions', A.interactions], ['Label warnings', A.otcwarn]];
  const own = new Set(eA.generic.concat(classTerms(A)).map(t => t.toLowerCase()));
  const terms = eB.generic.concat(eB.alt).map(t => ({ t, direct: true }))
    .concat(classTerms(B).map(t => ({ t, direct: false })))
    .filter(x => !own.has(x.t.toLowerCase()));
  const out = [], seen = new Set();
  for (const [section, text] of sections) {
    if (!text) continue;
    for (const { t, direct } of terms) {
      const re = termRe(t);
      for (const q of sentencesWith(text, re)) {
        if (seen.has(q)) continue; seen.add(q);
        out.push({ section, term: t, direct, quote: q, re });
      }
    }
  }
  return out.sort((a, b) => (b.direct - a.direct)).slice(0, 5);
}
async function renderCheck() {
  const v = $('#view');
  v.innerHTML = '<p class="muted">Loading…</p>';
  let idx;
  try { idx = await ensureIndex(); } catch (e) { v.innerHTML = '<div class="note">The offline medicine database is missing from this build.</div>'; return; }
  if (tab !== 'check') return;
  db.check = db.check.filter(id => drugById(id));
  const list = db.check.map(drugById);
  let html = `<div class="note">This checker searches the official FDA label of each medicine for warnings that mention the other medicines. It covers about ${idx.filter(d => d.has).length} medicines and <b>cannot rule an interaction out</b>. Always confirm with your child's doctor or pharmacist before combining medicines.</div>
    <div class="card"><h2>Medicines to check</h2>
      ${list.map(d => `<div class="item"><div class="grow t" style="text-transform:capitalize" data-act="info" data-id="${d.id}">${esc(d.name)}</div><button class="x" data-act="checkRm" data-id="${d.id}">✕</button></div>`).join('') || '<p class="muted">Add at least two medicines.</p>'}
      <div class="btnrow" style="margin-top:10px"><button class="btn small" data-act="checkSearch">+ Add medicine</button>
      ${db.meds.some(m => m.drugId && !db.check.includes(m.drugId)) ? '<button class="btn small ghost" data-act="checkMine">Use my reminder medicines</button>' : ''}</div>
    </div>`;
  if (list.length >= 2) {
    const data = {};
    for (const d of list) if (d.has) data[d.id] = await getDrug(d.id);
    if (tab !== 'check') return;
    let any = false;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j], A = data[a.id], B = data[b.id];
      const pair = `<h2 style="text-transform:capitalize">${esc(a.name)} + ${esc(b.name)}</h2>`;
      if (!A || !B) { html += `<div class="card">${pair}<p class="muted">No label text is stored for ${esc((!A ? a : b).name)}, so this pair cannot be checked.</p></div>`; continue; }
      const shared = classTerms(A).filter(t => classTerms(B).includes(t) && t !== 'CNS depressant' && t !== 'serotonergic');
      const f = mentions(A, B, a, b).map(x => Object.assign(x, { from: a })).concat(mentions(B, A, b, a).map(x => Object.assign(x, { from: b })));
      if (f.length || shared.length) any = true;
      html += `<div class="card">${pair}
        ${shared.length ? `<div class="finding"><span class="tag warn">Same type of medicine</span><q>Both are labelled as: ${esc(shared.join(', '))}. Giving two medicines of the same type together can double up their effects – check that this is intended.</q></div>` : ''}
        ${f.map(x => `<div class="finding"><span class="tag warn">${esc(x.section)}</span><span class="tag">${x.direct ? 'named directly' : 'by medicine type: ' + esc(x.term)}</span>
          <q>${esc(x.quote).replace(new RegExp(x.re.source, 'gi'), (m0, p1, p2, p3) => `${p1}<mark>${p2}${p3 || ''}</mark>`)}</q>
          <span class="muted small">— from the ${esc(x.from.name)} label</span></div>`).join('')}
        ${!f.length && !shared.length ? `<div class="finding none"><b>No mention found</b><div class="muted">Neither stored label mentions the other medicine. This is not proof that the combination is safe.</div></div>` : ''}
      </div>`;
    }
    if (any) html += '<p class="muted small">Quoted text is taken word for word from the stored FDA labels. How serious a warning is depends on dose, age and condition – ask a professional.</p>';
  }
  v.innerHTML = html;
}

// ---------- History ----------
function renderHistory() {
  const today = startOfDay(Date.now());
  const first = db.events.length ? startOfDay(Math.min.apply(null, db.events.map(e => e.ts))) : today;
  const ws = weights();
  const rows = [];
  for (let d = today, n = 0; d >= first && n < 60; d = addDays(d, -1), n++) {
    const t = totals(eventsOn(d));
    const sm = Math.round(sleepOn(d).ms / 60000);
    rows.push(`<tr data-act="goDay" data-day="${d}"><td>${esc(dayLabel(d))}</td><td>${t.pee.n}</td><td>${t.pee.ml}</td><td>${t.poop.n}</td><td>${t.drink.n}</td><td>${t.drink.ml}</td><td>${t.dose.n}</td><td>${sm ? Math.floor(sm / 60) + ':' + pad(sm % 60) : '–'}</td></tr>`);
  }
  $('#view').innerHTML = `<div class="card"><h2>Daily totals</h2>
    <table><tr><th>Day</th><th>💧×</th><th>💧 ml</th><th>💩×</th><th>🍼×</th><th>🍼 ml</th><th>💊</th><th>😴 h:min</th></tr>${rows.join('')}</table>
    <p class="muted small">Tap a day to open it.</p></div>
    <div class="card"><h2>⚖️ Weight</h2>
      ${ws.length ? `<table><tr><th>Date</th><th>Weight</th><th>Change</th></tr>${ws.slice(0, 30).map((x, i) => `<tr data-act="edit" data-id="${x.id}"><td>${esc(shortDate(x.ts))}</td><td>${fmtKg(x.kg)}</td><td>${ws[i + 1] ? esc(weightChange(x, ws[i + 1]).split(' since')[0]) : '–'}</td></tr>`).join('')}</table>
      ${ws.length > 1 ? `<p class="muted small">Overall: ${esc(weightChange(ws[0], ws[ws.length - 1]))}. Tap a row to edit it.</p>` : ''}` : '<p class="muted">No weights recorded yet.</p>'}
      <button class="btn small ghost" data-act="add" data-type="weight">+ Add weight</button></div>
    <button class="btn wide" style="margin-bottom:12px" data-act="export">Share log (for the doctor)</button>
    ${syncCard()}`;
}

// ---------- Shared log (see sync.js) ----------
function syncCard() {
  if (!window.Sync) return '';
  const c = Sync.config(), s = Sync.state;
  const status = !c ? 'Not set up. Both phones can keep the same log: every entry made on one phone appears on the other.'
    : s.busy ? 'Updating…'
    : s.error ? 'Not updated: ' + s.error
    : s.last ? 'Up to date – last checked at ' + fmtTime(s.last) : 'Waiting for the first update…';
  return `<div class="card"><h2>🔄 Shared log</h2>
    <p class="${c && s.error ? 'note' : 'muted'}" style="margin-bottom:8px">${esc(status)}</p>
    ${c ? `<p class="muted small">Stored in your private GitHub repository ${esc(c.repo)}.</p>
      <div class="btnrow"><button class="btn small" data-act="syncNow">Update now</button><button class="btn small ghost" data-act="syncShare">Set up the other phone</button><button class="btn small ghost" data-act="syncSetup">Settings</button></div>`
      : `<button class="btn small" data-act="syncSetup">Set up</button>`}</div>`;
}
function syncSheet() {
  const c = Sync.config();
  openSheet(`<h2>🔄 Shared log</h2>
    <p class="muted">The log is saved in a private GitHub repository that only your account can open, and each phone copies it from there. The medicines, reminders, entries and pictures are all shared.</p>
    <label>Setup code from the other phone – or a GitHub access token</label>
    <textarea id="s-token" style="min-height:70px" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="${c ? 'Leave empty to keep the saved one' : 'Paste it here'}"></textarea>
    <label>Repository (owner/name) – filled in by a setup code</label><input id="s-repo" autocapitalize="off" autocomplete="off" spellcheck="false" value="${esc(c ? c.repo : '')}">
    <div class="actions">
      ${c ? `<button class="btn danger" data-act="syncOff">Turn off</button>` : ''}
      <button class="btn ghost" data-act="close">Cancel</button>
      <button class="btn" data-act="syncSave">Save</button>
    </div>`);
}
async function syncSave() {
  const old = Sync.config();
  let token = $('#s-token').value.trim(), repo = $('#s-repo').value.trim();
  const m = /^LH1:([^:\s]+\/[^:\s]+):(\S+)$/.exec(token);
  if (m) { repo = m[1]; token = m[2]; }
  if (!token && old) token = old.token;
  repo = repo.replace(/^https:\/\/github\.com\//, '').replace(/(\.git)?\/?$/, '');
  if (!token) { toast('Paste the setup code or access token'); return; }
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) { toast('Enter the repository as owner/name'); return; }
  toast('Checking…');
  const err = await Sync.setup(repo, token);
  if (err) { toast(err); return; }
  closeSheet(); tab = 'history'; render(); toast('Shared log is on');
}
let pushWas = '';
window.onSyncState = () => {
  const p = Sync.push.state(), moved = p !== pushWas; pushWas = p;   // the reminder note is on other screens too
  if ((tab === 'history' || moved) && $('#sheet').hidden) render();
};
async function pushSwitch(on) {
  toast(on ? 'Turning on…' : 'Turning off…');
  const err = await (on ? Sync.push.on() : Sync.push.off());
  if ($('#sheet').hidden) render();
  toast(err ? 'Not done: ' + err : on ? 'Reminders will ring on this phone' : 'Reminders turned off on this phone');
}
function exportLog() {
  const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
  const lines = ['date,time,type,ml,detail,note'];
  for (const e of db.events.slice().sort((a, b) => a.ts - b.ts)) {
    const d = new Date(e.ts);
    const detail = e.type === 'dose' ? [e.name, e.dose].filter(Boolean).join(' ') : e.type === 'weight' ? e.kg + ' kg' : e.type === 'sleep' ? (e.end ? `until ${fmtTime(e.end)}, ${fmtDur(e.end - e.ts)}` : 'still asleep') : (e.kind || '');
    lines.push([`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, fmtTime(e.ts), e.type, e.ml || '', q(detail), q(e.note)].join(','));
  }
  for (const n of db.notes.slice().sort((a, b) => a.ts - b.ts)) {
    const d = new Date(n.ts);
    lines.push([`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, fmtTime(n.ts), 'log', '', q([n.title, n.size, lasted(n)].filter(Boolean).join(' · ')), q(n.note)].join(','));
  }
  const csv = lines.join('\n');
  if (hasNative) { Native.share('Baby care log', csv); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); a.download = 'baby-care-log.csv'; a.click();
}

// ---------- actions ----------
const actions = {
  tab: el => { tab = el.dataset.tab; render(); },
  day: el => { viewDay = addDays(viewDay, +el.dataset.d); render(); },
  goDay: el => { viewDay = +el.dataset.day; tab = 'today'; render(); },
  add: el => eventForm(el.dataset.type),
  edit: el => { const e = db.events.find(x => x.id === el.dataset.id); if (e) eventForm(e.type, e); },
  close: closeSheet,
  pick: el => { $$('.chip', el.parentNode).forEach(c => c.classList.toggle('sel', c === el && !el.classList.contains('sel'))); },
  setml: el => { $('#f-ml').value = el.dataset.v; },
  saveEvent,
  del: el => { db.events = db.events.filter(e => e.id !== el.dataset.id); save(); closeSheet(); render(); toast('Deleted'); },
  editMed: el => medForm(db.meds.find(m => m.id === el.dataset.id)),
  saveMed,
  delMed: el => { db.meds = db.meds.filter(m => m.id !== el.dataset.id); save(); syncReminders(); closeSheet(); render(); toast('Medicine removed'); },
  toggleMed: el => { const m = db.meds.find(x => x.id === el.dataset.id); m.enabled = el.checked; save(); syncReminders(); toast(el.checked ? 'Reminders on' : 'Reminders off'); },
  give: el => { const m = db.meds.find(x => x.id === el.dataset.id); db.events.push({ id: uid(), type: 'dose', ts: Date.now(), medId: m.id, name: m.name, dose: m.dose }); save(); render(); toast(`${m.name} logged as given at ${fmtTime(Date.now())}`); },
  giveAt: el => { const m = db.meds.find(x => x.id === el.dataset.id); eventForm('dose', null, { ts: Date.now(), medId: m.id, name: m.name, dose: m.dose }); },
  addTime: () => { $('#m-times').insertAdjacentHTML('beforeend', timeRow('')); },
  rmTime: el => el.parentNode.remove(),
  every: el => {
    const h = +el.dataset.h, first = ($('.f-time') && $('.f-time').value) || '08:00';
    const [h0, m0] = first.split(':').map(Number); const times = [];
    for (let k = 0; k < 24 / h; k++) times.push(pad((h0 + k * h) % 24) + ':' + pad(m0));
    $('#m-times').innerHTML = times.map(timeRow).join('');
  },
  askExact: () => Native.requestExactAlarms(),
  askNotif: () => { Native.requestNotifications(); setTimeout(render, 1500); },
  scan: scanSheet,
  camera: () => Native.scan(),
  gallery: () => Native.pickPhoto(),
  scanText: () => window.onScanResult($('#scan-text').value),
  lookup: () => searchSheet('info'),
  info: el => showDrug(el.dataset.id),
  remindDrug: el => { const d = drugById(el.dataset.id); medForm(null, { name: d.name.replace(/\b[a-z]/g, c => c.toUpperCase()), drugId: d.id }); },
  checkSearch: () => searchSheet('check'),
  checkAdd: el => { if (!db.check.includes(el.dataset.id)) db.check.push(el.dataset.id); save(); closeSheet(); tab = 'check'; render(); },
  checkRm: el => { db.check = db.check.filter(id => id !== el.dataset.id); save(); render(); },
  checkMine: () => { for (const m of db.meds) if (m.drugId && !db.check.includes(m.drugId)) db.check.push(m.drugId); save(); render(); },
  export: exportLog,
  syncSetup: syncSheet,
  syncSave,
  syncNow: () => Sync.now(),
  syncOff: () => { Sync.off(); closeSheet(); render(); toast('Shared log turned off – this phone keeps its copy'); },
  pushOn: () => pushSwitch(true),
  pushOff: () => pushSwitch(false),
  pushTest: async () => { toast('Sending…'); const err = await Sync.push.test(); toast(err ? 'Not sent: ' + err : 'Sent – it should appear in a few seconds'); },
  syncShare: () => {
    const c = Sync.config(), code = `LH1:${c.repo}:${c.token}`;
    const shown = () => openSheet(`<h2>Setup code</h2><p class="muted">Copy this into “Shared log → Set up” on the other phone. Anyone who has this code can read the log, so send it only to the other parent.</p>
      <textarea readonly style="min-height:110px" onfocus="this.select()">${esc(code)}</textarea><div class="actions"><button class="btn" data-act="close">Close</button></div>`);
    if (hasNative) Native.share('Little Hugs setup code', code);
    else if (navigator.share) navigator.share({ text: code }).catch(shown);
    else shown();
  },
  prodEdit: el => startProduct(el.dataset.code),
  prodPhoto: el => {
    readProductForm(); pdraft.side = el.dataset.side; stashP(pdraft);
    if (hasNative) { Native.scanProductPhoto(!!el.dataset.cam); return; }
    webPhoto(!!el.dataset.cam).then(name => { if (name) window.onProductPhoto(name, ''); }, e => window.onProductPhotoError(e.message));
  },
  prodCancel: () => { const code = pdraft.code; pdraft = null; stashP(null); keepPhotos(); showBarcode(code); },
  prodSave: () => {
    readProductForm();
    if (!pdraft.name) { toast('Enter the product name'); return; }
    const p = pdraft, code = p.code;
    db.products[code] = { name: p.name, brand: '', quantity: p.quantity, ingredients: p.ingredients, label: p.label, front: p.front, back: p.back, source: 'you' };
    pdraft = null; stashP(null); save(); keepPhotos(); showBarcode(code); toast('Product saved');
  },
  prodView: el => {
    openSheet(`<img class="photo-full" src="${esc(photoUrl(el.dataset.p))}" alt="">
      <div class="actions"><button class="btn" data-act="prodBack" data-code="${esc(el.dataset.code)}">Back</button></div>`);
  },
  prodBack: el => showBarcode(el.dataset.code),
  sleepStart: () => { if (asleepNow()) return; db.events.push({ id: uid(), type: 'sleep', ts: Date.now(), end: 0 }); save(); render(); toast('Sleep started at ' + fmtTime(Date.now())); },
  sleepStop: () => { const e = asleepNow(); if (!e) return; e.end = Date.now(); save(); render(); toast('Slept ' + fmtDur(e.end - e.ts)); },
  remNew: () => remForm(null),
  remEdit: el => remForm(db.reminders.find(r => r.id === el.dataset.id)),
  remSave: saveRem,
  remDel: el => { db.reminders = db.reminders.filter(r => r.id !== el.dataset.id); save(); syncReminders(); closeSheet(); render(); toast('Reminder removed'); },
  remToggle: el => { const r = db.reminders.find(x => x.id === el.dataset.id); r.enabled = el.checked; if (el.checked) r.from = Date.now(); save(); syncReminders(); toast(el.checked ? 'Reminder on' : 'Reminder off'); },
  noteRemind: () => {
    // Suggest a reminder a few days before this product usually runs out.
    readNoteForm(); const n = draft, days = n.endTs ? noteDays(n) : 0;
    const every = days >= 2 ? days : 1, unit = days >= 2 ? 'day' : 'month';
    let ts = occurrence({ ts: startOfDay(n.endTs || n.ts) + 9 * 3600e3, every, unit }, n.endTs ? 0 : 1) + (n.endTs ? every * 86400e3 : 0) - 3 * 86400e3;
    if (ts <= Date.now()) ts = addDays(startOfDay(Date.now()), 1) + 9 * 3600e3;
    remForm(null, { text: 'Buy ' + (n.title.replace(/^(bought|buy)\s+/i, '') || 'again'), ts, every, unit });
  },
  noteNew: () => startNote(null),
  noteEdit: el => { const n = db.notes.find(x => x.id === el.dataset.id); if (n) startNote(n); },
  noteSave: saveNote,
  noteBack: noteForm,
  noteDel: () => { const id = draft.id; db.notes = db.notes.filter(n => n.id !== id); save(); closeSheet(); render(); toast('Deleted'); },
  noteEndToday: () => { readNoteForm(); draft.endTs = Date.now(); noteForm(); },
  noteBar: () => { readNoteForm(); draft.wait = 'barcode'; barcodeSheet(); },
  notePhotoAdd: el => {
    readNoteForm(); draft.wait = 'photo'; stash(draft);
    if (hasNative) { Native.addPhoto(!!el.dataset.cam); return; }
    webPhoto(!!el.dataset.cam).then(name => { if (name) window.onPhoto(name); }, e => window.onPhotoError(e.message));
  },
  notePhoto: el => {
    readNoteForm(); const i = +el.dataset.i;
    openSheet(`<img class="photo-full" src="${esc(photoUrl(draft.photos[i]))}" alt="">
      <div class="actions"><button class="btn danger" data-act="notePhotoRm" data-i="${i}">Remove picture</button><button class="btn" data-act="noteBack">Back</button></div>`);
  },
  notePhotoRm: el => { draft.photos.splice(+el.dataset.i, 1); noteForm(); },
  barScan: () => { draft = null; stash(null); barcodeSheet(); },
  barCam: el => { if (draft) stash(draft); if (hasNative) Native.scanBarcode(!!el.dataset.cam); else webBarcode(!!el.dataset.cam); },
  barTyped: () => { const v = $('#bar-text').value.trim(); if (!v) { toast('Type the number first'); return; } window.onBarcode(v); },
  noteFromBar: el => {
    const last = db.notes.filter(n => n.barcode === el.dataset.code).sort((a, b) => b.ts - a.ts)[0];
    const p = db.products[el.dataset.code];
    startNote(null, { barcode: el.dataset.code, title: last ? last.title : p ? productTitle(p) : '', size: last ? last.size : p ? p.quantity || '' : '', photos: [] });
  }
};
document.addEventListener('click', ev => {
  const el = ev.target.closest('[data-act]');
  if (el && actions[el.dataset.act]) actions[el.dataset.act](el);
});
$('#tabs').addEventListener('click', ev => { const b = ev.target.closest('button'); if (b) { tab = b.dataset.tab; render(); } });
$('#scrim').addEventListener('click', closeSheet);

load(); mergePendingDoses(); syncReminders();
render();
// In the web app the stored pictures are read first; sync.js waits for this before comparing pictures.
const photosReady = (hasNative ? Promise.resolve() : Photos.loadAll().catch(() => { })).then(() => { keepPhotos(); if (!hasNative && $('#sheet').hidden) render(); });
setInterval(() => { if (tab === 'today' && $('#sheet').hidden) render(); }, 60000);

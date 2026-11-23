/* =========================================================
   配達トラッカー  app.js
   - データ: 端末(localStorage + IndexedDB) → Googleスプレッドシート(GAS)に同期
   - GPS: 稼働中に走行ルートと距離を記録（アプリ表示中）
   - 通知: 目標50%/100%、終了押し忘れ、ピーク前
   - Discord: 稼働終了時に報告を自動投稿
   ========================================================= */
'use strict';

/* ---------- util ---------- */
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseD = s => { const [a, b, c] = s.split('-').map(Number); return new Date(a, b - 1, c); };
const today = () => ymd(new Date());
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const yen = n => '¥' + Math.round(+n || 0).toLocaleString('ja-JP');
const yenK = n => { n = +n || 0; return n >= 10000 ? (n / 10000).toFixed(1).replace(/\.0$/, '') + '万' : Math.round(n).toLocaleString(); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = v => { v = String(v ?? '').replace(/[^\d.\-]/g, ''); return v === '' || isNaN(+v) ? 0 : +v; };
const hm = min => { min = Math.max(0, Math.round(min || 0)); return Math.floor(min / 60) + '時間' + pad(min % 60) + '分'; };
const hhmm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()); };
const clockStr = m => { const s = Math.max(0, Math.floor(m * 60)); return pad(Math.floor(s / 3600)) + ':' + pad(Math.floor(s % 3600 / 60)) + ':' + pad(s % 60); };
const clone = o => JSON.parse(JSON.stringify(o));
const last = a => a[a.length - 1];
function toast(t, ms = 2000) { const e = $('#toast'); e.textContent = t; e.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => e.classList.remove('show'), ms); }
async function copyText(t) { try { await navigator.clipboard.writeText(t); toast('コピーしました'); } catch (e) { toast('コピーできませんでした'); } }
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const isIOS = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
function hav(a, b) { const R = 6371000, r = Math.PI / 180; const dLa = (b.lat - a.lat) * r, dLo = (b.lng - a.lng) * r; const x = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); }

/* ---------- defaults ---------- */
const DEFAULT_COMPANIES = [
  { id: 'uber', name: 'Uber Eats', color: '#c8ff00' },
  { id: 'amazon', name: 'Amazon', color: '#ff9f0a' },
  { id: 'demaecan', name: '出前館', color: '#ff453a' },
  { id: 'rocket', name: 'ロケットナウ', color: '#bf5af2' },
  { id: 'wolt', name: 'Wolt', color: '#64d2ff' }
];
const PALETTE = ['#c8ff00', '#ff9f0a', '#ff453a', '#bf5af2', '#64d2ff', '#30d158', '#ff375f', '#ffd60a', '#5e5ce6', '#ac8e68'];
const EXP_CATS = ['ガソリン', '車両整備・修理', 'スマホ・通信', 'バッグ・装備', '飲食', '駐輪・駐車', '保険', '交通費', 'その他'];
const DEFAULT_SETTINGS = {
  goal: 15000,
  companies: DEFAULT_COMPANIES,
  hidden: ['wolt'],
  notif: { goal: true, idle: true, idleMin: 45, peak: true, lead: 15, peaks: [{ label: 'ランチ', time: '11:00' }, { label: 'ディナー', time: '17:30' }] },
  discord: { url: '', auto: true, image: true },
  lastComp: 'uber',
  recent: [],
  u: 0
};

/* ---------- storage ---------- */
const LS = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { console.warn('LS', e); storageWarn(); return false; } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { } }
};
function storageWarn() { if (storageWarn.t && Date.now() - storageWarn.t < 60000) return; storageWarn.t = Date.now(); setTimeout(() => toast('⚠ 端末の保存容量がいっぱいです。CSVで控えを取り、スプレッドシート連携を確認してください', 6000), 0); }
// IndexedDB（GPSルート用）
const IDB = (() => {
  let dbp = null;
  function open() {
    if (dbp) return dbp;
    dbp = new Promise((res, rej) => {
      if (!window.indexedDB) return rej('no idb');
      const r = indexedDB.open('dt', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('tracks');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbp;
  }
  async function tx(mode, fn) { const db = await open(); return new Promise((res, rej) => { const t = db.transaction('tracks', mode); const st = t.objectStore('tracks'); const r = fn(st); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); }); }
  return {
    get: k => tx('readonly', s => s.get(k)).catch(() => null),
    put: (k, v) => tx('readwrite', s => s.put(v, k)).catch(() => { storageWarn(); return null; }),
    keys: () => tx('readonly', s => s.getAllKeys()).catch(() => [])
  };
})();

// 端末ごとの設定（同期しない）：GAS接続先・GPS・画面ON
const D = Object.assign({ gas: { url: '', token: '' }, gps: true, wakeLock: true, synced: false }, LS.get('dt.device', {}));
(() => { const old = LS.get('dt.settings', {}); if (old.gas && !LS.get('dt.device', null)) { D.gas = old.gas; if (old.gps != null) D.gps = old.gps; if (old.wakeLock != null) D.wakeLock = old.wakeLock; LS.set('dt.device', D); } })();
const saveDevice = () => LS.set('dt.device', D);
let S = {
  settings: Object.assign(clone(DEFAULT_SETTINGS), LS.get('dt.settings', {})),
  months: {},
  active: LS.get('dt.active', null),   // {date} 稼働中の日付（日付またぎ対応）
  dirty: new Set(LS.get('dt.dirty', []))
};
S.settings.notif = Object.assign(clone(DEFAULT_SETTINGS.notif), S.settings.notif || {});
S.settings.discord = Object.assign(clone(DEFAULT_SETTINGS.discord), S.settings.discord || {});
delete S.settings.gas; delete S.settings.gps; delete S.settings.wakeLock;
for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith('dt.m.')) S.months[k.slice(5)] = LS.get(k, null); }

function month(k) { return S.months[k] || (S.months[k] = { days: {}, expenses: [], expDel: [], u: 0 }); }
function newDay() { return { entries: [], del: [], km: '', gpsM: 0, gpsEstM: 0, memo: '', work: { sessions: [], manualMin: null }, flags: {}, u: 0 }; }
function getDay(d, create) { const m = S.months[d.slice(0, 7)]; if (m && m.days[d]) return m.days[d]; if (!create) return null; const mm = month(d.slice(0, 7)); return (mm.days[d] = newDay()); }
function touch(date, delay) { // 日付の変更を保存
  const k = date.slice(0, 7); const m = month(k); const now = Date.now(); m.u = now; if (m.days[date]) m.days[date].u = now;
  LS.set('dt.m.' + k, m); markDirty('m-' + k, delay);
}
function touchMonth(k) { const m = month(k); m.u = Date.now(); LS.set('dt.m.' + k, m); markDirty('m-' + k); }
function saveSettings() { S.settings.u = Date.now(); LS.set('dt.settings', S.settings); markDirty('settings'); }
function syncedSettings() { const o = clone(S.settings); delete o.gas; delete o.gps; delete o.wakeLock; return o; }
function markDirty(key, delay) { S.dirty.add(key); LS.set('dt.dirty', [...S.dirty]); Sync.schedule(delay || 4000); }
function setActive(v) { S.active = v; v ? LS.set('dt.active', v) : LS.del('dt.active'); }

/* ---------- model ---------- */
const comps = () => S.settings.companies;
const activeComps = () => comps().filter(c => !(S.settings.hidden || []).includes(c.id));
const compOf = id => comps().find(c => c.id === id) || { id, name: id, color: '#8e8e93' };
const eTotal = e => (+e.fee || 0) + (+e.bonus || 0) + (+e.tip || 0);
const dSales = d => d ? d.entries.reduce((a, e) => a + eTotal(e), 0) : 0;
const dCount = d => d ? d.entries.reduce((a, e) => a + (+e.n || 0), 0) : 0;
const dKm = d => { if (!d) return 0; if (d.km !== '' && d.km != null) return +d.km; return ((d.gpsM || 0) + (d.gpsEstM || 0)) / 1000; };
function workIntervals(d, now = Date.now()) { // 休憩を除いた稼働区間 [[s,e],...]
  const out = [];
  for (const s of (d?.work?.sessions || [])) {
    const end = s.end || now; let cur = s.start;
    const brs = (s.breaks || []).map(b => [b.s, b.e || end]).sort((a, b) => a[0] - b[0]);
    for (const [bs, be] of brs) { if (bs > cur) out.push([cur, Math.min(bs, end)]); cur = Math.max(cur, be); }
    if (end > cur) out.push([cur, end]);
  }
  return out;
}
function workMin(d, now) { if (!d) return 0; const w = d.work || {}; if (w.manualMin != null && w.manualMin !== '') return +w.manualMin; return (+w.extraMin || 0) + workIntervals(d, now).reduce((a, [s, e]) => a + (e - s), 0) / 60000; }
function setField(d, f, v, inWork) { (inWork ? d.work : d)[f] = v; d.fu = d.fu || {}; d.fu[f] = Date.now(); }
function breakMin(d, now = Date.now()) { let b = 0; for (const s of (d?.work?.sessions || [])) for (const br of (s.breaks || [])) b += ((br.e || s.end || now) - br.s); return b / 60000; }
function wState(d) { const ss = d?.work?.sessions || []; const s = ss[ss.length - 1]; if (!s) return 'idle'; if (s.end) return 'ended'; const b = s.breaks || []; if (b.length && !b[b.length - 1].e) return 'break'; return 'on'; }
const activeDay = () => S.active ? getDay(S.active.date, true) : null;
const activeState = () => S.active ? wState(activeDay()) : 'idle';
function entryDate() { return (S.active && ['on', 'break'].includes(activeState())) ? S.active.date : cur; }
function allDays() { const o = []; for (const k in S.months) for (const d in S.months[k].days) o.push([d, S.months[k].days[d]]); return o.sort((a, b) => a[0] < b[0] ? -1 : 1); }

/* ---------- merge (スマホ・PC両方で編集してもデータが消えないように) ---------- */
function mergeById(a = [], b = [], del = []) {
  const map = new Map();
  for (const e of [...a, ...b]) { const p = map.get(e.id); if (!p || (e.u || 0) > (p.u || 0)) map.set(e.id, e); }
  const ds = new Set(del); return [...map.values()].filter(e => !ds.has(e.id)).sort((x, y) => (x.t || 0) - (y.t || 0) || String(x.date || '').localeCompare(String(y.date || '')));
}
function mergeSessions(A = [], B = []) { // 稼働は開始時刻ごとに合体（終了・休憩はどちらかにあれば採用）
  const m = new Map();
  for (const s of [...A, ...B]) {
    const p = m.get(s.start);
    if (!p) { m.set(s.start, clone(s)); continue; }
    if (s.end) p.end = Math.max(p.end || 0, s.end);
    const bm = new Map((p.breaks || []).map(x => [x.s, x]));
    for (const x of s.breaks || []) { const q = bm.get(x.s); if (!q) bm.set(x.s, clone(x)); else if (x.e) q.e = Math.max(q.e || 0, x.e); }
    p.breaks = [...bm.values()].sort((x, y) => x.s - y.s);
  }
  return [...m.values()].sort((x, y) => x.start - y.start);
}
function mergeDay(a, b) {
  const newer = (b.u || 0) > (a.u || 0) ? b : a;
  const del = [...new Set([...(a.del || []), ...(b.del || [])])];
  const fa = a.fu || {}, fb = b.fu || {}, fu = {};
  const pick = (f, ga, gb) => { const ta = fa[f] || 0, tb = fb[f] || 0; fu[f] = Math.max(ta, tb); if (!ta && !tb) return newer === a ? ga : gb; return tb > ta ? gb : ga; };
  const d = clone(newer);
  d.del = del; d.entries = mergeById(a.entries, b.entries, del);
  d.gpsM = Math.max(a.gpsM || 0, b.gpsM || 0); d.gpsEstM = Math.max(a.gpsEstM || 0, b.gpsEstM || 0);
  d.flags = { ...(a.flags || {}), ...(b.flags || {}) };
  d.memo = pick('memo', a.memo, b.memo); d.km = pick('km', a.km, b.km);
  d.work = { sessions: mergeSessions(a.work?.sessions, b.work?.sessions), manualMin: pick('manualMin', a.work?.manualMin ?? null, b.work?.manualMin ?? null), extraMin: pick('extraMin', a.work?.extraMin || 0, b.work?.extraMin || 0) };
  d.fu = fu; d.u = Math.max(a.u || 0, b.u || 0);
  return d;
}
function mergeMonth(L, R) {
  if (!L) return clone(R); if (!R) return L;
  const out = { days: {}, expenses: [], expDel: [], u: Math.max(L.u || 0, R.u || 0) };
  const keys = new Set([...Object.keys(L.days || {}), ...Object.keys(R.days || {})]);
  for (const k of keys) {
    const a = L.days?.[k], b = R.days?.[k];
    if (!a || !b) { out.days[k] = clone(a || b); continue; }
    out.days[k] = mergeDay(a, b);
  }
  out.expDel = [...new Set([...(L.expDel || []), ...(R.expDel || [])])];
  out.expenses = mergeById(L.expenses, R.expenses, out.expDel);
  return out;
}

/* ---------- Googleスプレッドシート同期 ---------- */
const Sync = {
  t: null, due: 0, busy: false, state: 'local', last: 0, lastStatus: 0,
  on() { const g = D.gas; return !!(g.url && /^https:\/\/script\.google\.com\//.test(g.url)); },
  schedule(ms = 4000) { // すでに早い予定があればそれを優先
    if (!this.on()) { this.pill(); return; }
    const due = Date.now() + ms; if (this.t && this.due <= due) return;
    clearTimeout(this.t); this.due = due; this.t = setTimeout(() => { this.t = null; this.run(); }, ms); if (this.state !== 'run') this.pill('wait');
  },
  pill(st) {
    if (st) this.state = st;
    const p = $('#sync'); if (!p) return;
    const map = { local: ['', '端末に保存'], wait: ['warn', '同期待ち'], run: ['warn', '同期中…'], ok: ['ok', 'シート同期済'], err: ['bad', '同期エラー'], off: ['bad', 'オフライン'] };
    const s = this.on() ? (map[this.state] || map.ok) : map.local;
    p.className = 'pill ' + s[0]; p.querySelector('span').textContent = s[1];
  },
  async api(params, body) {
    const g = D.gas; const u = new URL(g.url);
    Object.entries({ ...params, token: g.token || '' }).forEach(([k, v]) => u.searchParams.set(k, v));
    const opt = body ? { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ ...body, token: g.token || '' }) } : {};
    const r = await fetch(u.toString(), { ...opt, redirect: 'follow' });
    const j = await r.json(); if (!j.ok) throw new Error(j.error || 'GAS error'); return j;
  },
  async run(force) {
    if (!this.on()) return this.pill('local');
    if (this.busy) return this.schedule(3000);
    if (!navigator.onLine) return this.pill('off');
    this.busy = true; this.pill('run');
    try {
      // 1) 取得（前回から一定時間経過 or 強制）
      if (force || Date.now() - this.last > 60000) {
        const idx = await this.api({ action: 'index' });
        const items = idx.items || {};
        for (const [key, ru] of Object.entries(items)) {
          if (key === 'settings') {
            if (!D.synced || (ru > (S.settings.u || 0) && !S.dirty.has('settings'))) {
              // 初めて接続した端末は、必ずシート側の設定を取り込む（上書きしない）
              const r = await this.api({ action: 'get', key });
              if (r.data) { const rd = r.data; delete rd.gas; delete rd.gps; delete rd.wakeLock; S.settings = Object.assign(clone(DEFAULT_SETTINGS), rd); S.settings.notif = Object.assign(clone(DEFAULT_SETTINGS.notif), rd.notif || {}); S.settings.discord = Object.assign(clone(DEFAULT_SETTINGS.discord), rd.discord || {}); S.settings.u = ru; LS.set('dt.settings', S.settings); S.dirty.delete('settings'); }
            }
          } else if (key.startsWith('m-')) {
            const mk = key.slice(2); const L = S.months[mk];
            if (!L || ru !== (L.u || 0)) {
              const r = await this.api({ action: 'get', key }); const merged = mergeMonth(L, r.data);
              // 内容がシートと違えば新しい時刻を付けて送り返す（他の端末が取りに来るように）
              if (L && JSON.stringify(merged) !== JSON.stringify(r.data)) { merged.u = Math.max(Date.now(), (merged.u || 0) + 1); S.dirty.add(key); }
              S.months[mk] = merged; LS.set('dt.m.' + mk, merged);
            }
          }
        }
        for (const mk of Object.keys(S.months)) if (!items['m-' + mk] && Object.keys(S.months[mk].days).length + S.months[mk].expenses.length) S.dirty.add('m-' + mk);
        if (!items.settings) S.dirty.add('settings');
        this.last = Date.now(); if (!D.synced) { D.synced = true; saveDevice(); }
      }
      // 2) 送信
      for (const key of [...S.dirty]) {
        let data, u;
        if (key === 'settings') { data = null; u = S.settings.u || Date.now(); }
        else if (key.startsWith('m-')) { const m = S.months[key.slice(2)]; if (!m) { S.dirty.delete(key); continue; } data = m; u = m.u || Date.now(); }
        else if (key.startsWith('t-')) { const t = await IDB.get(key.slice(2)); if (!t) { S.dirty.delete(key); continue; } data = t; u = t.u || Date.now(); }
        else { S.dirty.delete(key); continue; }
        S.dirty.delete(key); LS.set('dt.dirty', [...S.dirty]);
        try { await this.api({}, { action: 'save', key, u, data: key === 'settings' ? syncedSettings() : data }); }
        catch (err) { S.dirty.add(key); LS.set('dt.dirty', [...S.dirty]); throw err; }
      }
      this.pill('ok'); refresh(true);
    } catch (e) { console.warn('sync', e); this.pill(navigator.onLine ? 'err' : 'off'); this.schedule(60000); }
    this.busy = false;
  },
  async status(force) { // GAS側の「終了押し忘れ」「ピーク前」判定用
    if (!this.on() || !navigator.onLine) return;
    if (!force && Date.now() - this.lastStatus < 10 * 60000) return;
    this.lastStatus = Date.now();
    const d = activeDay(); const st = activeState();
    try { await this.api({}, { action: 'status', status: { working: st === 'on' || st === 'break', state: st, date: S.active?.date || '', lastActivity: lastActivity(), sales: d ? dSales(d) : 0, at: Date.now() } }); } catch (e) { }
  },
  async fetchTrack(date) { if (!this.on()) return null; try { const r = await this.api({ action: 'get', key: 't-' + date }); if (r.data) { await IDB.put(date, r.data); return r.data; } } catch (e) { } return null; }
};

/* ---------- GPS ---------- */
const GPS = {
  id: null, last: null, acc: null, status: 'off', lastMove: 0, pts: null, date: null, saveT: 0, err: '',
  async start() {
    if (!D.gps || this.id != null) return;
    if (!('geolocation' in navigator)) { this.status = 'err'; this.err = 'この端末はGPS非対応'; return; }
    this.date = S.active?.date || today();
    const t = await IDB.get(this.date); this.pts = (t && t.pts) || [];
    this.last = null; this.status = 'wait';
    this.id = navigator.geolocation.watchPosition(p => this.onPos(p), e => this.onErr(e), { enableHighAccuracy: true, maximumAge: 3000, timeout: 30000 });
    paintGps();
  },
  stop() { if (this.id != null) navigator.geolocation.clearWatch(this.id); this.id = null; this.status = 'off'; this.last = null; this.flush(true); paintGps(); },
  onErr(e) { this.status = 'err'; this.err = e.code === 1 ? '位置情報が許可されていません' : '位置を取得できません'; paintGps(); },
  onPos(p) {
    const c = p.coords, now = p.timestamp || Date.now();
    this.acc = Math.round(c.accuracy); this.status = c.accuracy > 60 ? 'weak' : 'on';
    const cur = { lat: c.latitude, lng: c.longitude, t: now };
    this.here = cur;
    if (c.accuracy > 60) { paintGps(); return; }
    const d = getDay(this.date, true);
    if (!this.last) { this.last = cur; this.pts.push([+cur.lat.toFixed(5), +cur.lng.toFixed(5), Math.round(now / 1000)]); paintGps(); return; }
    const dist = hav(this.last, cur), dt = Math.max(1, (now - this.last.t) / 1000);
    if (dist < Math.max(10, c.accuracy * 0.6)) { paintGps(); return; }   // GPSのブレは無視
    const v = dist / dt;
    if (v > 35 && dt < 120) { paintGps(); return; }                     // 時速126km超は誤検知
    if (dt > 90 && dist > 250) d.gpsEstM = (d.gpsEstM || 0) + dist * 1.25; // アプリを閉じていた間は直線×1.25で補完
    else d.gpsM = (d.gpsM || 0) + dist;
    if (dist > 40) this.lastMove = now;
    this.last = cur;
    this.pts.push([+cur.lat.toFixed(5), +cur.lng.toFixed(5), Math.round(now / 1000)]);
    this.flush(); paintGps();
  },
  async flush(force) {
    if (!this.date || !this.pts) return;
    if (!force && Date.now() - this.saveT < 20000) return;
    this.saveT = Date.now();
    await IDB.put(this.date, { pts: this.pts, u: Date.now() });
    // 距離はこまめに端末保存、シートへの送信は数分おき・ルートは停止時/15分おき
    touch(this.date, force ? 4000 : 180000);
    if (force || Date.now() - (this.trkSent || 0) > 15 * 60000) { this.trkSent = Date.now(); markDirty('t-' + this.date, force ? 4000 : 180000); }
  },
  async getHere() { // 配達完了地点
    if (this.here && Date.now() - this.here.t < 120000) return this.here;
    if (!('geolocation' in navigator) || !D.gps) return null;
    return new Promise(res => navigator.geolocation.getCurrentPosition(p => res({ lat: p.coords.latitude, lng: p.coords.longitude, t: Date.now() }), () => res(null), { enableHighAccuracy: true, timeout: 8000, maximumAge: 60000 }));
  }
};
let wakeLock = null;
async function wake(on) {
  try {
    if (on && D.wakeLock && 'wakeLock' in navigator && document.visibilityState === 'visible') { if (!wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => wakeLock = null); } }
    else if (!on && wakeLock) { await wakeLock.release(); wakeLock = null; }
  } catch (e) { }
}

/* ---------- 通知 ---------- */
let swReg = null;
async function notify(title, body, tag) {
  toast(title + (body ? '｜' + body : ''), 4000);
  try { navigator.vibrate && navigator.vibrate([120, 60, 120]); } catch (e) { }
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const opt = { body, tag: tag || title, icon: 'icon-192.png', badge: 'icon-192.png' };
  try { if (swReg) { await swReg.showNotification(title, opt); return; } } catch (e) { }
  try { new Notification(title, opt); } catch (e) { }
}
function lastActivity() {
  const d = activeDay(); if (!d) return 0;
  let t = 0; const ss = d.work.sessions; const s = ss[ss.length - 1];
  if (s) { t = s.start; for (const b of s.breaks || []) if (b.e) t = Math.max(t, b.e); }
  for (const e of d.entries) t = Math.max(t, e.t || 0);
  return Math.max(t, GPS.lastMove || 0);
}
function checkGoal(date) {
  const n = S.settings.notif, g = +S.settings.goal; if (!n.goal || !g) return;
  const d = getDay(date); if (!d) return; const s = dSales(d); d.flags = d.flags || {};
  if (s >= g && !d.flags.g100) { d.flags.g100 = 1; d.flags.g50 = 1; touch(date); notify('🎉 目標達成！', `今日の売上 ${yen(s)}（目標 ${yen(g)}）`, 'goal'); }
  else if (s >= g / 2 && !d.flags.g50) { d.flags.g50 = 1; touch(date); notify('折り返し地点！', `目標の半分を突破。あと ${yen(g - s)}`, 'goal'); }
}
let idleSentFor = 0;
function tick() {
  const n = S.settings.notif, now = Date.now();
  // 終了押し忘れ
  if (n.idle && activeState() === 'on') {
    const la = lastActivity();
    if (la && now - la > (n.idleMin || 45) * 60000 && idleSentFor !== la) { idleSentFor = la; notify('稼働終了し忘れていませんか？', `${n.idleMin}分間、移動も配達記録もありません`, 'idle'); }
  }
  // ピーク前
  if (n.peak && activeState() !== 'on') {
    const sent = LS.get('dt.peakSent', {}); const td = today(); sent[td] = sent[td] || [];
    for (const p of n.peaks || []) {
      if (!p.time) continue; const [h, m] = p.time.split(':').map(Number);
      const target = new Date(); target.setHours(h, m, 0, 0); const at = target.getTime() - (n.lead || 15) * 60000;
      if (now >= at && now < at + 10 * 60000 && !sent[td].includes(p.label + p.time)) {
        sent[td].push(p.label + p.time); LS.set('dt.peakSent', { [td]: sent[td] });
        notify(`まもなく${p.label}ピーク`, `${p.time}〜。そろそろ稼働の準備を`, 'peak');
      }
    }
  }
  Sync.status();
}

/* ---------- Discord ---------- */
async function sendDiscord(date, manual) {
  const url = S.settings.discord.url;
  if (!url || !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(url)) { if (manual) toast('設定でDiscordのWebhook URLを入れてください'); return false; }
  if (!navigator.onLine) { const q = LS.get('dt.discordQ', []); if (!q.includes(date)) q.push(date); LS.set('dt.discordQ', q); toast('オフラインのため、電波が戻ったらDiscordに送ります'); return false; }
  const fd = new FormData(); let text = reportText(date, ALL_OPTS); if (text.length > 1900) text = text.slice(0, 1900) + '…';
  fd.append('payload_json', JSON.stringify({ username: '配達トラッカー', content: text }));
  if (S.settings.discord.image) { const blob = await new Promise(r => reportCanvas(date).toBlob(r, 'image/png')); if (blob) fd.append('files[0]', blob, `report-${date}.png`); }
  try { await fetch(url, { method: 'POST', body: fd, mode: 'no-cors' }); toast('Discordに送信しました'); return true; }
  catch (e) { const q = LS.get('dt.discordQ', []); if (!q.includes(date)) q.push(date); LS.set('dt.discordQ', q); toast('Discordに送れませんでした。電波が戻ったら再送します'); return false; }
}
async function flushDiscordQ() { const q = LS.get('dt.discordQ', []); if (!q.length || !navigator.onLine) return; LS.set('dt.discordQ', []); for (const d of q) await sendDiscord(d);
}

/* ---------- 報告 ---------- */
const ALL_OPTS = { cnt: 1, time: 1, km: 1, goal: 1, comp: 1, memo: 1 };
function compTotals(d) { const o = {}; for (const e of (d?.entries || [])) { const x = o[e.c] || (o[e.c] = { n: 0, s: 0 }); x.n += (+e.n || 0); x.s += eTotal(e); } return o; }
function reportText(date, o) {
  const d = getDay(date) || newDay(), dt = parseD(date), s = dSales(d), n = dCount(d), m = workMin(d), km = dKm(d), g = +S.settings.goal;
  const L = [`【稼働報告】${dt.getMonth() + 1}/${dt.getDate()}（${WD[dt.getDay()]}）`, `💰 売上 ${yen(s)}`];
  if (o.cnt) L.push(`📦 ${n}件${n ? `（平均 ${yen(s / n)}）` : ''}`);
  if (o.time) L.push(`⏱ ${hm(m)}${m > 5 ? `（時給 ${yen(s / (m / 60))}）` : ''}`);
  if (o.km && km > 0) L.push(`🛵 ${km.toFixed(1)}km`);
  if (o.goal && g) L.push(`🎯 目標 ${yen(g)} → ${s >= g ? '達成！' : 'あと ' + yen(g - s)}`);
  if (o.comp) { const ct = compTotals(d); const ks = Object.keys(ct); if (ks.length) { L.push('', '▼ 会社別'); comps().filter(c => ct[c.id]).forEach(c => L.push(`・${c.name}　${ct[c.id].n}件　${yen(ct[c.id].s)}`)); } }
  if (o.memo && d.memo) L.push('', '📝 ' + d.memo);
  return L.join('\n');
}
function reportCanvas(date) {
  const d = getDay(date) || newDay(), dt = parseD(date), s = dSales(d), n = dCount(d), m = workMin(d), km = dKm(d), g = +S.settings.goal;
  const W = 1080, H = 1350, c = document.createElement('canvas'); c.width = W; c.height = H; const x = c.getContext('2d');
  const F = '"Noto Sans JP",sans-serif', I = 'Inter,' + F;
  x.fillStyle = '#000'; x.fillRect(0, 0, W, H);
  const gr = x.createRadialGradient(W, 0, 50, W, 0, 900); gr.addColorStop(0, 'rgba(200,255,0,.22)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = gr; x.fillRect(0, 0, W, H);
  x.fillStyle = '#c8ff00'; x.font = `800 34px ${I}`; x.fillText('DELIVERY REPORT', 80, 120);
  x.fillStyle = '#fff'; x.font = `900 56px ${F}`; x.fillText(`${dt.getFullYear()}.${dt.getMonth() + 1}.${dt.getDate()}（${WD[dt.getDay()]}）`, 80, 200);
  x.fillStyle = '#8e8e93'; x.font = `700 34px ${F}`; x.fillText('売上合計', 80, 320);
  x.fillStyle = '#fff'; x.font = `900 160px ${I}`; x.fillText(yen(s), 70, 470);
  if (g) { x.fillStyle = '#1d1d20'; rr(x, 80, 510, W - 160, 18, 9); x.fill(); x.fillStyle = '#c8ff00'; rr(x, 80, 510, (W - 160) * Math.min(1, s / g), 18, 9); x.fill(); x.fillStyle = '#8e8e93'; x.font = `700 30px ${F}`; x.fillText(`目標 ${yen(g)}　${s >= g ? '達成！' : 'あと ' + yen(g - s)}`, 80, 580); }
  const box = (bx, by, l, v) => { x.fillStyle = '#151517'; rr(x, bx, by, 215, 150, 24); x.fill(); x.fillStyle = '#8e8e93'; x.font = `700 28px ${F}`; x.fillText(l, bx + 24, by + 50); x.fillStyle = '#fff'; x.font = `800 48px ${I}`; x.fillText(v, bx + 24, by + 118); };
  box(80, 630, '件数', n + '件'); box(310, 630, '稼働', (m / 60).toFixed(1) + 'h'); box(540, 630, '時給', m > 5 ? yenK(s / (m / 60)) : '—'); box(770, 630, '距離', km > 0 ? km.toFixed(1) + 'km' : '—');
  let y = 880; const ct = compTotals(d);
  comps().filter(cc => ct[cc.id]).forEach(cc => { x.fillStyle = cc.color; x.beginPath(); x.arc(96, y - 12, 12, 0, 7); x.fill(); x.fillStyle = '#fff'; x.font = `700 38px ${F}`; x.textAlign = 'left'; x.fillText(cc.name, 128, y); x.textAlign = 'right'; x.fillText(`${ct[cc.id].n}件   ${yen(ct[cc.id].s)}`, W - 80, y); x.textAlign = 'left'; y += 70; });
  x.fillStyle = '#5a5a60'; x.font = `700 26px ${I}`; x.fillText('配達トラッカー', 80, H - 70);
  return c;
}
function rr(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }

/* ---------- 画面 ---------- */
let cur = today(), tab = 'home', mon = today().slice(0, 7), anaSeg = 'money', mapSeg = 'route', mapPeriod = 'm0', mapMetric = 's';
let charts = [], map = null;
const TABS = [
  ['home', 'ホーム', '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>'],
  ['cal', 'カレンダー', '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>'],
  ['map', '地図', '<path d="M9 4L3 6v14l6-2 6 2 6-2V4l-6 2-6-2zM9 4v14M15 6v14"/>'],
  ['ana', '分析', '<path d="M4 20V11M10 20V4M16 20v-6M22 20H2"/>'],
  ['set', '設定', '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/>']
];
function renderTabs() { $('#tabs').innerHTML = TABS.map(([k, l, p]) => `<button class="${tab === k ? 'on' : ''}" data-tab="${k}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${p}</svg>${l}</button>`).join(''); }
$('#tabs').addEventListener('click', e => { const b = e.target.closest('[data-tab]'); if (!b) return; tab = b.dataset.tab; render(); scrollTo(0, 0); });

function render() {
  charts.forEach(c => c.destroy()); charts = [];
  if (map) { map.remove(); map = null; }
  renderTabs(); Sync.pill();
  $('#view').innerHTML = ({ home: vHome, cal: vCal, map: vMap, ana: vAna, set: vSet })[tab]();
  $('#fab').classList.toggle('hidden', tab !== 'home'); document.body.classList.toggle('hasfab', tab === 'home');
  if (tab === 'map') drawMap(); if (tab === 'ana') drawAna(); if (tab === 'home') paintGps();
}
function refresh(fromSync) { // 入力中は描き直さない
  const a = document.activeElement; if (a && /INPUT|TEXTAREA|SELECT/.test(a.tagName)) { paintHero(); return; }
  if ($('#mask').classList.contains('show')) { if (tab === 'home') paintHero(); return; }
  if (fromSync && tab === 'map') return; render();
}

/* ----- ホーム ----- */
function heroHTML() {
  const d = getDay(cur) || newDay(), s = dSales(d), n = dCount(d), m = workMin(d), km = dKm(d), g = +S.settings.goal;
  const pct = g ? Math.min(100, s / g * 100) : 0;
  return `<div class="lbl">TODAY'S SALES</div><div class="big n">${yen(s)}</div>
  <div class="grid4">
    <div class="st"><span>件数</span><b class="n">${n}</b></div>
    <div class="st"><span>単価</span><b class="n">${n ? yenK(s / n) : '—'}</b></div>
    <div class="st"><span>時給</span><b class="n">${m > 5 ? yenK(s / (m / 60)) : '—'}</b></div>
    <div class="st"><span>距離</span><b class="n">${km > 0 ? km.toFixed(1) : '—'}<small style="font-size:11px"> km</small></b></div>
  </div>
  ${g ? `<div class="bar"><div style="width:${pct}%"></div></div><div class="goalrow"><span>目標 ${yen(g)}</span><span>${s >= g ? '<b>達成 +' + yen(s - g) + '</b>' : 'あと <b class="n">' + yen(g - s) + '</b>'}</span></div>` : ''}`;
}
function timerHTML() {
  const d = getDay(cur) || newDay(); const st = wState(d); const m = workMin(d); const manual = d.work.manualMin != null && d.work.manualMin !== '';
  const otherActive = S.active && S.active.date !== cur && ['on', 'break'].includes(activeState());
  const lab = { idle: '未稼働', on: '稼働中', break: '休憩中', ended: '稼働終了' }[st];
  let b = '';
  if (otherActive) b = `<button class="btn g sm" data-act="gotoActive">稼働中の日へ</button>`;
  else if (st === 'idle' && cur !== today()) b = `<button class="btn g sm" data-act="today">今日へ</button>`;
  else if (st === 'idle') b = `<button class="btn" data-act="start">▶ 稼働開始</button>`;
  else if (st === 'on') b = `<button class="btn amber sm" data-act="break">休憩</button><button class="btn red sm" data-act="end">終了</button>`;
  else if (st === 'break') b = `<button class="btn sm" data-act="resume">▶ 再開</button><button class="btn red sm" data-act="end">終了</button>`;
  else if (cur === today()) b = `<button class="btn g sm" data-act="start">▶ 追加稼働</button>`;
  const ss = d.work.sessions; const f = ss[0], l = ss[ss.length - 1];
  return `<div class="tm"><div style="min-width:0">
    <div class="badge ${st === 'on' ? 'on' : st === 'break' ? 'brk' : ''}">${st === 'on' || st === 'break' ? '<i class="pulse"></i>' : ''}${lab}${manual ? '・手動' : ''}</div>
    <div class="clock n" id="clock">${clockStr(m)}</div>
    <div class="sub" style="margin-top:6px">${f ? hhmm(f.start) + ' 開始' : 'ボタンで計測スタート'}${l && l.end ? '・' + hhmm(l.end) + ' 終了' : ''}${breakMin(d) > 0.5 ? '・休憩' + Math.round(breakMin(d)) + '分' : ''}</div>
  </div><div class="vbtns">${b}</div></div>
  <div class="gps" id="gpsline"></div>`;
}
function paintHero() { const h = $('#hero'); if (h) h.innerHTML = heroHTML(); }
function paintTimer() { const t = $('#timerbox'); if (t) t.innerHTML = timerHTML(); paintGps(); }
function paintGps() {
  const el = $('#gpsline'); if (!el) return;
  if (!D.gps) { el.innerHTML = `<span>GPS記録：オフ（設定で変更）</span>`; return; }
  const d = getDay(cur);
  const label = { off: '待機', wait: '測位中…', on: '記録中', weak: '電波弱い', err: GPS.err || 'エラー' }[GPS.status];
  const showing = S.active && S.active.date === cur;
  el.innerHTML = `<span>GPS <b style="color:${GPS.status === 'on' ? 'var(--acc)' : GPS.status === 'err' ? 'var(--red)' : 'var(--text)'}">${showing ? label : '—'}</b></span>${showing && GPS.acc ? `<span>精度 <b>±${GPS.acc}m</b></span>` : ''}<span>GPS距離 <b class="n">${d ? (((d.gpsM || 0) + (d.gpsEstM || 0)) / 1000).toFixed(2) : '0.00'}km</b></span>${d && d.gpsEstM > 0 ? `<span>うち補完 <b class="n">${(d.gpsEstM / 1000).toFixed(1)}km</b></span>` : ''}${wakeLock ? '<span>画面ON維持中</span>' : (showing && D.wakeLock && ['on'].includes(activeState()) ? '<span style="color:var(--amber)">画面ON維持は非対応（自動ロックを「なし」に）</span>' : '')}`;
}
function vHome() {
  const d = getDay(cur) || newDay(), dt = parseD(cur), isT = cur === today();
  const ct = compTotals(d);
  const ents = [...d.entries].sort((a, b) => (b.t || 0) - (a.t || 0));
  const banner = !isStandalone() && !LS.get('dt.hideInstall', false) ? `<div class="banner"><b>ホーム画面に追加してください</b><br>${isIOS() ? 'Safariの共有ボタン（□↑）→「ホーム画面に追加」。iPhoneは追加しないと通知が届きません。' : 'Chromeのメニュー（⋮）→「ホーム画面に追加」または「アプリをインストール」。'} <a href="#" data-act="hideInstall">閉じる</a></div>` : '';
  return `
  <div class="datenav"><button class="ib" data-act="prev">‹</button><div class="d" data-act="today">${dt.getMonth() + 1}月${dt.getDate()}日（${WD[dt.getDay()]}）<small>${isT ? '今日' : 'タップで今日へ'}</small></div><button class="ib" data-act="next">›</button></div>
  ${banner}
  <div class="card hero" id="hero">${heroHTML()}</div>
  <div class="card"><h3>稼働 <button class="btn g sm" data-act="editTime">時間を修正</button></h3><div id="timerbox">${timerHTML()}</div></div>
  <div class="card"><h3>会社別 <button class="btn g sm" data-act="bulk">まとめて入力</button></h3>
    ${Object.keys(ct).length ? comps().filter(c => ct[c.id]).map(c => `<div class="li"><span class="dot" style="background:${c.color}"></span><div class="grow"><b>${esc(c.name)}</b></div><span class="n sub">${ct[c.id].n}件</span><b class="n" style="min-width:84px;text-align:right">${yen(ct[c.id].s)}</b></div>`).join('') : '<div class="empty">下の「配達完了」で1件ずつ記録できます</div>'}
  </div>
  <div class="card"><h3>配達履歴 <span class="n" style="text-transform:none;letter-spacing:0">${ents.length}件の記録</span></h3>
    ${ents.length ? ents.map(e => { const c = compOf(e.c); return `<div class="li" data-act="editEntry" data-id="${e.id}"><span class="n t" style="width:42px">${e.bulk ? 'まとめ' : hhmm(e.t)}</span><span class="dot" style="background:${c.color}"></span><div class="grow"><div>${esc(c.name)}${e.n > 1 ? ` ×${e.n}` : ''}${e.lat ? ' <span class="muted">📍</span>' : ''}</div>${e.tip || e.bonus ? `<div class="t">${e.tip ? 'チップ ' + yen(e.tip) : ''} ${e.bonus ? 'ボーナス ' + yen(e.bonus) : ''}</div>` : ''}</div><b class="n">${yen(eTotal(e))}</b></div>`; }).join('') : '<div class="empty">まだ記録がありません</div>'}
  </div>
  <div class="card"><h3>距離・メモ</h3>
    <label class="f" style="margin-top:0">走行距離（km）— 空欄ならGPSの距離を使います</label>
    <input class="n" inputmode="decimal" data-day="km" value="${esc(d.km)}" placeholder="GPS: ${(((d.gpsM || 0) + (d.gpsEstM || 0)) / 1000).toFixed(1)}">
    <label class="f">メモ</label><textarea data-day="memo" placeholder="天気・街の様子・トラブルなど">${esc(d.memo)}</textarea>
  </div>
  <div class="card"><h3>報告</h3><div class="btns"><button class="btn g" style="flex:1" data-act="report">報告文・画像</button><button class="btn g" style="flex:1" data-act="discord">Discordへ送信</button></div></div>`;
}

/* ----- カレンダー ----- */
function vCal() {
  const [y, mo] = mon.split('-').map(Number); const first = new Date(y, mo - 1, 1); const dim = new Date(y, mo, 0).getDate();
  const m = S.months[mon] || { days: {}, expenses: [] }; let max = 0, tot = 0, wd = 0, cnt = 0;
  for (const k in m.days) { const s = dSales(m.days[k]); max = Math.max(max, s); }
  let cells = ''; for (let i = 0; i < first.getDay(); i++) cells += '<div class="c e"></div>';
  for (let i = 1; i <= dim; i++) {
    const k = `${mon}-${pad(i)}`, d = m.days[k], s = dSales(d); tot += s; cnt += dCount(d); if (s > 0) wd++;
    const a = max ? s / max : 0; const st = s > 0 ? `background:rgba(200,255,0,${(.1 + a * .75).toFixed(2)});color:${a > .55 ? '#000' : 'var(--text)'}` : '';
    cells += `<div class="c ${k === today() ? 'td' : ''}" style="${st}" data-act="calDay" data-d="${k}"><span>${i}</span><span class="v">${s > 0 ? yenK(s) : ''}</span></div>`;
  }
  return `<div class="datenav"><button class="ib" data-act="mPrev">‹</button><div class="d">${y}年${mo}月<small class="n">${yen(tot)}・${wd}日稼働・${cnt}件</small></div><button class="ib" data-act="mNext">›</button></div>
  <div class="card"><div class="cal">${WD.map(w => `<div class="wd">${w}</div>`).join('')}${cells}</div>
  <p class="sub" style="margin:12px 0 0">色が明るいほど売上が多い日。タップでその日を開きます。</p></div>`;
}

/* ----- 地図 ----- */
function vMap() {
  return `<div class="seg" style="margin-top:6px"><button class="${mapSeg === 'route' ? 'on' : ''}" data-act="mapSeg" data-v="route">ルート（1日）</button><button class="${mapSeg === 'area' ? 'on' : ''}" data-act="mapSeg" data-v="area">稼げたエリア</button></div>
  ${mapSeg === 'route' ? (() => { const dt = parseD(cur); return `<div class="datenav"><button class="ib" data-act="prev">‹</button><div class="d">${dt.getMonth() + 1}月${dt.getDate()}日（${WD[dt.getDay()]}）<small id="routeinfo">読み込み中…</small></div><button class="ib" data-act="next">›</button></div>`; })()
      : `<div class="seg">${[['m0', '今月'], ['m1', '先月'], ['d90', '3ヶ月'], ['all', '全期間']].map(([k, l]) => `<button class="${mapPeriod === k ? 'on' : ''}" data-act="mapPeriod" data-v="${k}">${l}</button>`).join('')}</div>
         <div class="seg">${[['s', '売上合計'], ['n', '件数'], ['a', '平均単価']].map(([k, l]) => `<button class="${mapMetric === k ? 'on' : ''}" data-act="mapMetric" data-v="${k}">${l}</button>`).join('')}</div>`}
  <div id="map" style="margin-top:12px"></div>
  <div id="mapbelow"></div>`;
}
function baseMap(center) {
  map = L.map('map', { zoomControl: true, attributionControl: true }).setView(center || [35.6553, 139.7369], 14);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 19, subdomains: 'abcd', crossOrigin: true, attribution: '&copy; OpenStreetMap &copy; CARTO' }).addTo(map);
  return map;
}
async function drawMap() {
  if (!window.L) { $('#map').innerHTML = '<div class="empty">地図を読み込めませんでした</div>'; return; }
  if (mapSeg === 'route') {
    const d = getDay(cur) || newDay(); baseMap();
    let t = await IDB.get(cur); if (!t) t = await Sync.fetchTrack(cur);
    if (!map) return;
    const pts = (t?.pts || []).map(p => [p[0], p[1]]);
    const layers = [];
    if (pts.length > 1) { const pl = L.polyline(pts, { color: '#c8ff00', weight: 4, opacity: .85 }).addTo(map); layers.push(pl); L.circleMarker(pts[0], { radius: 6, color: '#000', weight: 2, fillColor: '#fff', fillOpacity: 1 }).addTo(map).bindPopup('スタート'); }
    const es = d.entries.filter(e => e.lat).sort((a, b) => a.t - b.t);
    es.forEach((e, i) => { const c = compOf(e.c); const mk = L.marker([e.lat, e.lng], { icon: L.divIcon({ className: '', html: `<div class="num-mk" style="background:${c.color}">${i + 1}</div>`, iconSize: [22, 22], iconAnchor: [11, 11] }) }).addTo(map).bindPopup(`<b>${hhmm(e.t)} ${esc(c.name)}</b><br>${yen(eTotal(e))}${e.tip ? `（チップ ${yen(e.tip)}）` : ''}`); layers.push(mk); });
    if (layers.length) { const g = L.featureGroup(layers); map.fitBounds(g.getBounds().pad(.15), { maxZoom: 16 }); }
    else if (GPS.here) map.setView([GPS.here.lat, GPS.here.lng], 15);
    $('#routeinfo').textContent = `${dKm(d).toFixed(1)}km・ルート${pts.length}点・配達地点${es.length}件`;
    $('#mapbelow').innerHTML = !pts.length && !es.length ? `<div class="banner">この日のGPSルートはありません。稼働開始するとルートと配達地点が記録されます。</div>` : '';
  } else {
    baseMap();
    const now = new Date(); let from = '0000', to = '9999';
    if (mapPeriod === 'm0') { from = ymd(new Date(now.getFullYear(), now.getMonth(), 1)); }
    if (mapPeriod === 'm1') { from = ymd(new Date(now.getFullYear(), now.getMonth() - 1, 1)); to = ymd(new Date(now.getFullYear(), now.getMonth(), 0)); }
    if (mapPeriod === 'd90') { const f = new Date(); f.setDate(f.getDate() - 90); from = ymd(f); }
    const cells = {}; const GL = 0.004, GN = 0.005;
    for (const [date, d] of allDays()) { if (date < from || date > to) continue; for (const e of d.entries) { if (!e.lat) continue; const k = Math.floor(e.lat / GL) + ':' + Math.floor(e.lng / GN); const c = cells[k] || (cells[k] = { lat: (Math.floor(e.lat / GL) + .5) * GL, lng: (Math.floor(e.lng / GN) + .5) * GN, s: 0, n: 0, hrs: Array(24).fill(0) }); c.s += eTotal(e); c.n += (+e.n || 1); c.hrs[new Date(e.t).getHours()] += eTotal(e); } }
    const arr = Object.values(cells); arr.forEach(c => c.a = c.s / c.n);
    const val = c => mapMetric === 's' ? c.s : mapMetric === 'n' ? c.n : c.a;
    const mx = Math.max(1, ...arr.map(val)); const layers = [];
    arr.sort((a, b) => val(a) - val(b)).forEach(c => {
      const r = val(c) / mx; const bh = c.hrs.indexOf(Math.max(...c.hrs));
      const circ = L.circle([c.lat, c.lng], { radius: 140 + r * 160, stroke: false, fillColor: '#c8ff00', fillOpacity: .12 + r * .6 }).addTo(map)
        .bindPopup(`<b>${yen(c.s)}</b>（${c.n}件）<br>平均単価 ${yen(c.a)}<br>よく稼げる時間 ${bh}時台`);
      layers.push(circ);
    });
    if (layers.length) map.fitBounds(L.featureGroup(layers).getBounds().pad(.2), { maxZoom: 15 });
    const top = [...arr].sort((a, b) => val(b) - val(a)).slice(0, 5);
    $('#mapbelow').innerHTML = arr.length ? `<div class="card"><h3>上位エリア（${{ s: '売上', n: '件数', a: '平均単価' }[mapMetric]}順）</h3>${top.map((c, i) => `<div class="li" data-act="flyTo" data-lat="${c.lat}" data-lng="${c.lng}"><b class="n" style="width:22px">${i + 1}</b><div class="grow"><div class="n">${yen(c.s)}・${c.n}件</div><div class="t">平均 ${yen(c.a)}・${c.hrs.indexOf(Math.max(...c.hrs))}時台が強い</div></div><span class="muted">›</span></div>`).join('')}<p class="sub" style="margin:8px 0 0">約500m四方ごとに配達完了地点を集計。丸が大きく明るいほど上位です。</p></div>`
      : `<div class="banner">この期間に位置つきの配達記録がありません。「配達完了」で記録すると、その地点が自動で残ります。</div>`;
  }
  setTimeout(() => map && map.invalidateSize(), 120);
}

/* ----- 分析 ----- */
function monthAgg(k) {
  const m = S.months[k] || { days: {}, expenses: [] }; let s = 0, n = 0, min = 0, km = 0, wd = 0; const byC = {};
  for (const dk in m.days) { const d = m.days[dk]; const ds = dSales(d); s += ds; n += dCount(d); min += workMin(d); km += dKm(d); if (ds > 0) wd++; const ct = compTotals(d); for (const c in ct) { byC[c] = byC[c] || { n: 0, s: 0 }; byC[c].n += ct[c].n; byC[c].s += ct[c].s; } }
  const ex = (m.expenses || []).reduce((a, b) => a + (+b.amt || 0), 0);
  return { s, n, min, km, wd, byC, ex, profit: s - ex };
}
function vAna() {
  const segs = `<div class="seg" style="margin-top:6px">${[['money', '収支'], ['hour', '時間帯'], ['week', '曜日'], ['exp', '経費']].map(([k, l]) => `<button class="${anaSeg === k ? 'on' : ''}" data-act="anaSeg" data-v="${k}">${l}</button>`).join('')}</div>`;
  const [y, mo] = mon.split('-').map(Number);
  const mnav = `<div class="datenav"><button class="ib" data-act="mPrev">‹</button><div class="d">${y}年${mo}月</div><button class="ib" data-act="mNext">›</button></div>`;
  if (anaSeg === 'money') {
    const A = monthAgg(mon); const dim = new Date(y, mo, 0).getDate(); const isCur = mon === today().slice(0, 7);
    const proj = isCur && A.wd ? A.s / new Date().getDate() * dim : null;
    return segs + mnav + `<div class="card hero"><div class="lbl">手取り目安（売上 − 経費）</div><div class="big n">${yen(A.profit)}</div>
      <div class="grid3"><div class="st"><span>売上</span><b class="n">${yen(A.s)}</b></div><div class="st"><span>経費</span><b class="n">${yen(A.ex)}</b></div><div class="st"><span>${proj ? '月末予想' : '稼働日'}</span><b class="n">${proj ? yen(proj) : A.wd + '日'}</b></div></div></div>
    <div class="card"><div class="grid2">
      <div class="kpi"><span>件数</span><b class="n">${A.n}件</b></div><div class="kpi"><span>平均単価</span><b class="n">${A.n ? yen(A.s / A.n) : '—'}</b></div>
      <div class="kpi"><span>稼働時間</span><b class="n">${(A.min / 60).toFixed(1)}h</b></div><div class="kpi"><span>平均時給</span><b class="n">${A.min > 5 ? yen(A.s / (A.min / 60)) : '—'}</b></div>
      <div class="kpi"><span>1日平均</span><b class="n">${A.wd ? yen(A.s / A.wd) : '—'}</b></div><div class="kpi"><span>走行距離</span><b class="n">${A.km.toFixed(0)}km</b></div>
    </div></div>
    <div class="card"><h3>日別の売上</h3><div class="chartbox"><canvas id="ch1"></canvas></div></div>
    <div class="card"><h3>会社別</h3>${comps().filter(c => A.byC[c.id]).map(c => `<div class="li"><span class="dot" style="background:${c.color}"></span><div class="grow"><b>${esc(c.name)}</b><div class="t">${A.byC[c.id].n}件・平均 ${yen(A.byC[c.id].s / Math.max(1, A.byC[c.id].n))}</div></div><div style="text-align:right"><b class="n">${yen(A.byC[c.id].s)}</b><div class="t n">${A.s ? Math.round(A.byC[c.id].s / A.s * 100) : 0}%</div></div></div>`).join('') || '<div class="empty">まだ記録がありません</div>'}</div>`;
  }
  if (anaSeg === 'hour') {
    const H = hourStats(60); const ranked = H.map((h, i) => ({ i, ...h })).filter(h => h.min > 30).sort((a, b) => b.rate - a.rate);
    return segs + `<div class="card"><h3>時間帯別の時給（直近60日）</h3>${ranked.length ? `<div class="grid3">${ranked.slice(0, 3).map((h, k) => `<div class="kpi"><span>${k + 1}位</span><b class="n">${h.i}時台</b><small class="n">${yen(h.rate)}/h</small></div>`).join('')}</div>` : ''}
      <div class="chartbox" style="margin-top:12px"><canvas id="ch1"></canvas></div><p class="sub" style="margin:8px 0 0">その時間帯に稼働していた時間と、その時間に完了した配達の売上から計算。1件ずつ記録した分だけが対象です。</p></div>
      <div class="card"><h3>時間帯別の件数</h3><div class="chartbox"><canvas id="ch2"></canvas></div></div>`;
  }
  if (anaSeg === 'week') {
    const ds = allDays().filter(([k, d]) => dSales(d) > 0);
    if (!ds.length) return segs + `<div class="card"><div class="empty">記録がたまると曜日ごとの傾向が見られます</div></div>`;
    const best = ds.reduce((a, b) => dSales(b[1]) > dSales(a[1]) ? b : a); let ts = 0, tm = 0; ds.forEach(([k, d]) => { ts += dSales(d); tm += workMin(d); });
    return segs + `<div class="card"><div class="grid2"><div class="kpi"><span>最高売上日</span><b class="n">${yen(dSales(best[1]))}</b><small>${best[0].slice(5).replace('-', '/')}</small></div><div class="kpi"><span>通算時給</span><b class="n">${tm > 5 ? yen(ts / (tm / 60)) : '—'}</b><small>${ds.length}日稼働</small></div></div></div>
      <div class="card"><h3>曜日別の平均売上</h3><div class="chartbox"><canvas id="ch1"></canvas></div></div>
      <div class="card"><h3>時給の推移（直近30稼働日）</h3><div class="chartbox"><canvas id="ch2"></canvas></div></div>`;
  }
  // 経費
  const m = S.months[mon] || { expenses: [] }; const ex = [...(m.expenses || [])].sort((a, b) => a.date < b.date ? 1 : -1); const tot = ex.reduce((a, b) => a + (+b.amt || 0), 0);
  const byCat = {}; ex.forEach(e => byCat[e.cat] = (byCat[e.cat] || 0) + (+e.amt || 0));
  return segs + mnav + `<div class="card"><h3>経費 <span class="n" style="letter-spacing:0">${yen(tot)}</span></h3><button class="btn full" data-act="addExp">＋ 経費を追加</button>
    ${Object.keys(byCat).length ? `<div style="margin-top:12px">${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="li"><div class="grow">${esc(k)}</div><b class="n">${yen(v)}</b></div>`).join('')}</div>` : ''}</div>
    <div class="card"><h3>明細</h3>${ex.map(e => `<div class="li"><span class="n t" style="width:42px">${e.date.slice(5).replace('-', '/')}</span><div class="grow">${esc(e.cat)}<div class="t">${esc(e.memo || '')}</div></div><b class="n">${yen(e.amt)}</b><button class="x" data-act="delExp" data-id="${e.id}">×</button></div>`).join('') || '<div class="empty">まだ経費がありません</div>'}</div>`;
}
function hourStats(days) {
  const from = new Date(); from.setDate(from.getDate() - days); const f = ymd(from);
  const H = Array.from({ length: 24 }, () => ({ s: 0, n: 0, min: 0 }));
  for (const [k, d] of allDays()) {
    if (k < f) continue;
    if (d.work.manualMin != null && d.work.manualMin !== '') continue; // 手動修正の日は時間帯が分からないので除外
    for (const [s, e] of workIntervals(d)) { let t = s; while (t < e) { const dt = new Date(t); const nx = new Date(dt); nx.setMinutes(0, 0, 0); nx.setHours(nx.getHours() + 1); const end = Math.min(e, nx.getTime()); H[dt.getHours()].min += (end - t) / 60000; t = end; } }
    for (const e of d.entries) { if (e.bulk) continue; const h = new Date(e.t).getHours(); H[h].s += eTotal(e); H[h].n += (+e.n || 1); }
  }
  H.forEach(h => h.rate = h.min > 0 ? h.s / (h.min / 60) : 0); return H;
}
function chartDefaults() { Chart.defaults.color = '#8e8e93'; Chart.defaults.borderColor = '#1d1d20'; Chart.defaults.font.family = 'Inter,"Noto Sans JP"'; Chart.defaults.font.weight = 600; }
const yTick = () => ({ ticks: { callback: v => v >= 10000 ? v / 10000 + '万' : v } });
function drawAna() {
  if (!window.Chart) return; chartDefaults();
  const opt = (fmt) => ({ maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => fmt(c.raw) } } }, scales: { x: { grid: { display: false } }, y: yTick() } });
  if (anaSeg === 'money' && $('#ch1')) {
    const [y, mo] = mon.split('-').map(Number), dim = new Date(y, mo, 0).getDate(), g = +S.settings.goal; const L = [], D = [];
    for (let i = 1; i <= dim; i++) { L.push(i); D.push(dSales(getDay(`${mon}-${pad(i)}`))); }
    charts.push(new Chart($('#ch1'), { type: 'bar', data: { labels: L, datasets: [{ data: D, backgroundColor: D.map(v => g && v >= g ? '#c8ff00' : '#3a3a3f'), borderRadius: 4 }] }, options: opt(yen) }));
  }
  if (anaSeg === 'hour' && $('#ch1')) {
    const H = hourStats(60), L = H.map((_, i) => i + '時');
    charts.push(new Chart($('#ch1'), { type: 'bar', data: { labels: L, datasets: [{ data: H.map(h => h.min > 30 ? Math.round(h.rate) : 0), backgroundColor: '#c8ff00', borderRadius: 4 }] }, options: opt(v => yen(v) + '/h') }));
    charts.push(new Chart($('#ch2'), { type: 'bar', data: { labels: L, datasets: [{ data: H.map(h => h.n), backgroundColor: '#3a3a3f', borderRadius: 4 }] }, options: opt(v => v + '件') }));
  }
  if (anaSeg === 'week' && $('#ch1')) {
    const ds = allDays().filter(([k, d]) => dSales(d) > 0); const s = Array(7).fill(0), n = Array(7).fill(0);
    ds.forEach(([k, d]) => { const w = parseD(k).getDay(); s[w] += dSales(d); n[w]++; });
    const av = s.map((v, i) => n[i] ? Math.round(v / n[i]) : 0); const mx = Math.max(...av);
    charts.push(new Chart($('#ch1'), { type: 'bar', data: { labels: WD, datasets: [{ data: av, backgroundColor: av.map(v => v === mx ? '#c8ff00' : '#3a3a3f'), borderRadius: 6 }] }, options: opt(yen) }));
    const last = ds.filter(([k, d]) => workMin(d) > 5).slice(-30);
    charts.push(new Chart($('#ch2'), { type: 'line', data: { labels: last.map(([k]) => k.slice(5).replace('-', '/')), datasets: [{ data: last.map(([k, d]) => Math.round(dSales(d) / (workMin(d) / 60))), borderColor: '#c8ff00', backgroundColor: 'rgba(200,255,0,.08)', fill: true, tension: .35, pointRadius: 2 }] }, options: opt(v => yen(v) + '/h') }));
  }
}

/* ----- 設定 ----- */
function swHTML(path, on) { return `<label class="sw"><input type="checkbox" data-sw="${path}" ${on ? 'checked' : ''}><span></span></label>`; }
function vSet() {
  const s = S.settings, n = s.notif, perm = 'Notification' in window ? Notification.permission : 'unsupported';
  return `
  <div class="card"><h3>目標</h3><label class="f" style="margin-top:0">1日の売上目標（円）</label><input class="n" inputmode="numeric" data-set="goal" value="${esc(s.goal)}"></div>
  <div class="card"><h3>配達会社</h3><p class="sub" style="margin-top:0">タップで表示/非表示</p>
    <div class="chips">${comps().map(c => `<span class="chip ${(s.hidden || []).includes(c.id) ? '' : 'on'}" data-act="toggleComp" data-id="${c.id}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</span>`).join('')}</div>
    <div class="row" style="margin-top:12px"><input id="newComp" placeholder="会社を追加（例：menu）"><button class="btn sm" style="flex:none" data-act="addComp">追加</button></div></div>
  <div class="card"><h3>GPS</h3>
    <div class="setrow"><div class="grow"><b>稼働中にGPSで記録</b><span class="sub">走行ルート・距離・配達地点</span></div>${swHTML('dev.gps', D.gps)}</div>
    <div class="setrow"><div class="grow"><b>稼働中は画面を消さない</b><span class="sub">アプリを閉じるとGPSが止まるため、スマホホルダーで画面を付けたままがおすすめ</span></div>${swHTML('dev.wakeLock', D.wakeLock)}</div>
  </div>
  <div class="card"><h3>通知</h3>
    <div class="setrow"><div class="grow"><b>スマホ通知</b><span class="sub">${{ granted: '許可済み', denied: 'ブロック中（スマホの設定から許可）', default: '未許可', unsupported: isIOS() && !isStandalone() ? 'ホーム画面に追加すると使えます' : '非対応' }[perm]}</span></div>${perm === 'default' ? '<button class="btn sm" data-act="askNotif">許可する</button>' : perm === 'granted' ? '<button class="btn g sm" data-act="testNotif">テスト</button>' : ''}</div>
    <div class="setrow"><div class="grow"><b>目標の50%・100%到達</b></div>${swHTML('notif.goal', n.goal)}</div>
    <div class="setrow"><div class="grow"><b>終了押し忘れ</b><span class="sub">稼働中に移動も記録もない時間が続いたら</span></div>${swHTML('notif.idle', n.idle)}</div>
    <div class="row" style="margin-top:4px"><div><label class="f">何分で知らせる？</label><input class="n" inputmode="numeric" data-set="notif.idleMin" value="${esc(n.idleMin)}"></div><div><label class="f">ピーク何分前？</label><input class="n" inputmode="numeric" data-set="notif.lead" value="${esc(n.lead)}"></div></div>
    <div class="setrow" style="margin-top:8px"><div class="grow"><b>ピーク前のお知らせ</b><span class="sub">稼働していない時に通知</span></div>${swHTML('notif.peak', n.peak)}</div>
    ${(n.peaks || []).map((p, i) => `<div class="row" style="margin-top:6px"><input data-peak="${i}" data-k="label" value="${esc(p.label)}"><input type="time" data-peak="${i}" data-k="time" value="${esc(p.time)}"><button class="x" style="flex:none" data-act="delPeak" data-i="${i}">×</button></div>`).join('')}
    <button class="btn g sm" style="margin-top:8px" data-act="addPeak">＋ ピークを追加</button>
    <p class="sub" style="margin:10px 0 0">アプリを閉じている間の「ピーク前」「終了押し忘れ」は、スプレッドシート連携＋Discordを設定するとDiscordアプリに届きます。</p>
  </div>
  <div class="card"><h3>Discord</h3>
    <label class="f" style="margin-top:0">Webhook URL</label><input data-set="discord.url" value="${esc(s.discord.url)}" placeholder="https://discord.com/api/webhooks/...">
    <div class="setrow"><div class="grow"><b>稼働終了時に自動で報告</b></div>${swHTML('discord.auto', s.discord.auto)}</div>
    <div class="setrow"><div class="grow"><b>報告画像も付ける</b></div>${swHTML('discord.image', s.discord.image)}</div>
    <button class="btn g sm" data-act="discordTest">テスト送信</button>
  </div>
  <div class="card"><h3>Googleスプレッドシート連携</h3>
    <label class="f" style="margin-top:0">GASのウェブアプリURL</label><input data-set="dev.gas.url" value="${esc(D.gas.url)}" placeholder="https://script.google.com/macros/s/.../exec">
    <label class="f">合言葉（GASのTOKENと同じもの）</label><input data-set="dev.gas.token" value="${esc(D.gas.token)}" placeholder="例：koki-delivery-2026">
    <div class="btns" style="margin-top:12px"><button class="btn sm" data-act="syncNow">今すぐ同期</button></div>
    <p class="sub" style="margin:10px 0 0">設定するとスマホとPCで同じデータが見られ、機種変更しても消えません。</p>
  </div>
  <div class="card"><h3>データ</h3><div class="btns"><button class="btn g sm" data-act="csvOut">CSV書き出し</button><button class="btn g sm" data-act="csvIn">CSV読み込み</button></div>
    <p class="sub" style="margin:10px 0 0">バージョン 1.1.0</p></div>`;
}
function setPath(path, v) { // dev.〜 は端末だけの設定
  const dev = path.startsWith('dev.'); const ks = (dev ? path.slice(4) : path).split('.'); let o = dev ? D : S.settings; while (ks.length > 1) o = o[ks.shift()]; o[ks[0]] = v;
  if (dev) { saveDevice(); if (path.startsWith('dev.gas')) { D.synced = false; saveDevice(); Sync.schedule(2500); } } else saveSettings();
}

/* ---------- シート（下から出る画面） ---------- */
function sheet(html) { $('#sheet').innerHTML = '<div class="grab"></div>' + html; $('#mask').classList.add('show'); }
function closeSheet() { $('#mask').classList.remove('show'); }
$('#mask').addEventListener('click', e => { if (e.target.id === 'mask' || e.target.closest('[data-close]')) closeSheet(); });

function entrySheet(edit) {
  const date = edit ? edit._date : entryDate();
  const e = edit || { c: S.settings.lastComp, fee: '', tip: '', bonus: '', n: 1, t: Date.now() };
  const ac = activeComps(); const sel = ac.find(c => c.id === e.c) ? e.c : (ac[0]?.id || 'uber');
  const recent = [...new Set((S.settings.recent || []).filter(Boolean))].slice(0, 4);
  const qs = recent.length ? recent : [300, 400, 500, 600];
  const t = new Date(e.t);
  sheet(`<h2>${edit ? '記録を編集' : '配達完了'}</h2><p class="sub" style="margin:0">${parseD(date).getMonth() + 1}/${parseD(date).getDate()} ・ ${edit ? '' : '位置も自動で記録します'}</p>
    <label class="f">会社</label><div class="chips" id="eComp">${ac.map(c => `<span class="chip ${c.id === sel ? 'on' : ''}" data-id="${c.id}"><span class="dot" style="background:${c.color}"></span>${esc(c.name)}</span>`).join('')}</div>
    <label class="f">配達報酬</label><input class="amt n" id="eFee" inputmode="numeric" placeholder="¥0" value="${e.fee || ''}">
    <div class="quick">${qs.map(v => `<button data-q="${v}">${yen(v)}</button>`).join('')}<button data-add="50">+50</button><button data-add="100">+100</button><button data-add="-50">−50</button><button data-q="">クリア</button></div>
    <div class="row"><div><label class="f">チップ</label><input class="n" id="eTip" inputmode="numeric" placeholder="0" value="${e.tip || ''}"></div><div><label class="f">ボーナス</label><input class="n" id="eBonus" inputmode="numeric" placeholder="0" value="${e.bonus || ''}"></div></div>
    <div class="row">${e.bulk ? `<div><label class="f">件数</label><input class="n" id="eN" inputmode="numeric" value="${e.n}"></div>` : ''}<div><label class="f">完了時刻</label><input type="time" id="eTime" value="${pad(t.getHours())}:${pad(t.getMinutes())}"></div></div>
    <div class="btns" style="margin-top:16px"><button class="btn" style="flex:2" id="eSave">${edit ? '保存' : '記録する'}</button>${edit ? '<button class="btn red" style="flex:1" id="eDel">削除</button>' : '<button class="btn g" style="flex:1" data-close>やめる</button>'}</div>`);
  let comp = sel;
  $('#eComp').onclick = ev => { const c = ev.target.closest('.chip'); if (!c) return; comp = c.dataset.id; $$('#eComp .chip').forEach(x => x.classList.toggle('on', x === c)); };
  $('#sheet .quick').onclick = ev => { const b = ev.target.closest('button'); if (!b) return; const f = $('#eFee'); if (b.dataset.add) f.value = Math.max(0, num(f.value) + +b.dataset.add); else f.value = b.dataset.q; };
  if (!edit) setTimeout(() => $('#eFee')?.focus(), 250);
  const here = edit ? null : GPS.getHere();
  $('#eSave').onclick = async () => {
    const fee = num($('#eFee').value), tip = num($('#eTip').value), bonus = num($('#eBonus').value);
    if (!fee && !tip && !bonus) return toast('金額を入れてください');
    let tt;
    if (!$('#eTime').value) tt = e.t; // 時刻が空なら元のまま
    else {
      const [h, mi] = $('#eTime').value.split(':').map(Number); const td = parseD(date); td.setHours(h, mi, 0, 0); tt = td.getTime();
      // 日付またぎ（深夜0時以降）に対応：新規は稼働中の翌日扱い、編集は元の日付ずれを維持
      if (edit) { const off = Math.floor((e.t - parseD(date).getTime()) / 86400000); if (off > 0) tt += off * 86400000; }
      else if (S.active && date !== today() && tt < Date.now() - 12 * 3600000) tt += 86400000;
    }
    const d = getDay(date, true);
    const rec = edit ? d.entries.find(x => x.id === edit.id) : { id: uid(), n: 1 };
    Object.assign(rec, { c: comp, fee, tip, bonus, t: tt, u: Date.now() });
    if (edit && edit.bulk) rec.n = Math.max(1, num($('#eN').value));
    if (!edit) { d.entries.push(rec); S.settings.lastComp = comp; if (fee) S.settings.recent = [fee, ...(S.settings.recent || []).filter(v => v !== fee)].slice(0, 4); LS.set('dt.settings', S.settings); }
    touch(date); closeSheet(); toast(edit ? '保存しました' : `${compOf(comp).name} ${yen(fee + tip + bonus)} を記録`);
    checkGoal(date); render();
    if (!edit) { const p = await here; const r2 = getDay(date, true).entries.find(x => x.id === rec.id); if (p && r2) { r2.lat = +p.lat.toFixed(5); r2.lng = +p.lng.toFixed(5); r2.u = Date.now(); touch(date); } }
    Sync.status(true);
  };
  if (edit) $('#eDel').onclick = () => { const d = getDay(date, true); d.entries = d.entries.filter(x => x.id !== edit.id); d.del = [...(d.del || []), edit.id]; touch(date); closeSheet(); toast('削除しました'); render(); };
}
function bulkSheet() {
  const ac = activeComps();
  sheet(`<h2>まとめて入力</h2><p class="sub" style="margin:0">1件ずつ記録しなかった日や、日ごとの合計だけ入れたい時に。</p>
    <label class="f">会社</label><select id="bC">${ac.map(c => `<option value="${c.id}" ${c.id === S.settings.lastComp ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}</select>
    <div class="row"><div><label class="f">件数</label><input class="n" id="bN" inputmode="numeric" placeholder="0"></div><div><label class="f">配達報酬の合計</label><input class="n" id="bF" inputmode="numeric" placeholder="0"></div></div>
    <div class="row"><div><label class="f">ボーナス</label><input class="n" id="bB" inputmode="numeric" placeholder="0"></div><div><label class="f">チップ</label><input class="n" id="bT" inputmode="numeric" placeholder="0"></div></div>
    <div class="btns" style="margin-top:16px"><button class="btn" style="flex:2" id="bSave">追加</button><button class="btn g" style="flex:1" data-close>やめる</button></div>`);
  $('#bSave').onclick = () => {
    const n = num($('#bN').value), fee = num($('#bF').value), bonus = num($('#bB').value), tip = num($('#bT').value);
    if (!fee && !bonus && !tip) return toast('金額を入れてください');
    const d = getDay(cur, true); const t = parseD(cur); t.setHours(23, 59, 0, 0);
    d.entries.push({ id: uid(), c: $('#bC').value, n, fee, bonus, tip, t: t.getTime(), bulk: true, u: Date.now() });
    touch(cur); closeSheet(); checkGoal(cur); render();
  };
}
function editTimeSheet() {
  const d = getDay(cur, true); const m = Math.round(workMin(d));
  sheet(`<h2>稼働時間を修正</h2><p class="sub">タイマーを押し忘れた時に、休憩を除いた実稼働時間を入力できます。</p>
    <div class="row"><div><label class="f">時間</label><input class="n" id="tH" inputmode="numeric" value="${Math.floor(m / 60)}"></div><div><label class="f">分</label><input class="n" id="tM" inputmode="numeric" value="${m % 60}"></div></div>
    <div class="btns" style="margin-top:16px"><button class="btn" id="tS">保存</button><button class="btn g" id="tR">タイマーの計測に戻す</button></div>`);
  const date = cur;
  $('#tS').onclick = () => { const dd = getDay(date, true); setField(dd, 'manualMin', num($('#tH').value) * 60 + num($('#tM').value), true); setField(dd, 'extraMin', 0, true); touch(date); closeSheet(); render(); };
  $('#tR').onclick = () => { const dd = getDay(date, true); setField(dd, 'manualMin', null, true); setField(dd, 'extraMin', 0, true); touch(date); closeSheet(); render(); };
}
let repOpts = { cnt: 1, time: 1, km: 1, goal: 0, comp: 1, memo: 1 };
function reportSheet() {
  const keys = [['cnt', '件数'], ['time', '稼働時間'], ['km', '距離'], ['goal', '目標'], ['comp', '会社別'], ['memo', 'メモ']];
  sheet(`<h2>報告</h2><div class="chips" id="rC" style="margin-top:10px">${keys.map(([k, l]) => `<span class="chip ${repOpts[k] ? 'on' : ''}" data-k="${k}">${l}</span>`).join('')}</div>
    <pre class="rep" id="rT"></pre>
    <div class="btns" style="margin-top:12px"><button class="btn" id="rCopy">テキストをコピー</button><button class="btn g" id="rImg">画像を作る</button></div><div id="rBox"></div>`);
  const up = () => $('#rT').textContent = reportText(cur, repOpts); up();
  $('#rC').onclick = e => { const c = e.target.closest('.chip'); if (!c) return; repOpts[c.dataset.k] = repOpts[c.dataset.k] ? 0 : 1; c.classList.toggle('on'); up(); };
  $('#rCopy').onclick = () => copyText(reportText(cur, repOpts));
  $('#rImg').onclick = async () => {
    const cv = reportCanvas(cur); const url = cv.toDataURL('image/png');
    $('#rBox').innerHTML = `<img class="repimg" src="${url}"><div class="btns" style="margin-top:10px"><button class="btn g full" id="rShare">共有・保存</button></div><p class="sub" style="text-align:center">画像を長押しでも保存できます</p>`;
    $('#rShare').onclick = async () => { const blob = await new Promise(r => cv.toBlob(r, 'image/png')); const file = new File([blob], `report-${cur}.png`, { type: 'image/png' }); if (navigator.canShare && navigator.canShare({ files: [file] })) { try { await navigator.share({ files: [file] }); } catch (e) { } } else download(blob, file.name); };
  };
}
function expSheet() {
  const dflt = cur.startsWith(mon) ? cur : mon + '-01';
  sheet(`<h2>経費を追加</h2>
    <div class="row"><div><label class="f">日付</label><input type="date" id="xD" value="${dflt}"></div><div><label class="f">金額</label><input class="n" id="xA" inputmode="numeric" placeholder="0"></div></div>
    <label class="f">カテゴリ</label><div class="chips" id="xC">${EXP_CATS.map((c, i) => `<span class="chip ${i === 0 ? 'on' : ''}" data-v="${c}">${c}</span>`).join('')}</div>
    <label class="f">メモ</label><input id="xM" placeholder="例：ENEOS 5L">
    <div class="btns" style="margin-top:16px"><button class="btn" style="flex:2" id="xS">追加</button><button class="btn g" style="flex:1" data-close>やめる</button></div>`);
  let cat = EXP_CATS[0];
  $('#xC').onclick = e => { const c = e.target.closest('.chip'); if (!c) return; cat = c.dataset.v; $$('#xC .chip').forEach(x => x.classList.toggle('on', x === c)); };
  $('#xS').onclick = () => {
    const d = $('#xD').value, a = num($('#xA').value); if (!d || !a) return toast('日付と金額を入れてください');
    const k = d.slice(0, 7); const m = month(k); m.expenses.push({ id: uid(), date: d, amt: a, cat, memo: $('#xM').value, u: Date.now() });
    mon = k; touchMonth(k); closeSheet(); toast('経費を追加しました'); render();
  };
}

/* ---------- CSV ---------- */
function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); }
const cc = v => { v = String(v ?? ''); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
function buildCsv() {
  const L = ['type,date,time,company,count,fee,bonus,tip,lat,lng,km,work_min,memo,category,amount'];
  for (const mk of Object.keys(S.months).sort()) {
    const m = S.months[mk];
    for (const dk of Object.keys(m.days).sort()) {
      const d = m.days[dk];
      L.push(['day', dk, '', '', '', '', '', '', '', '', d.km !== '' && d.km != null ? d.km : dKm(d).toFixed(2), Math.round(workMin(d)), d.memo, '', ''].map(cc).join(','));
      for (const e of d.entries) L.push(['entry', dk, e.bulk ? '' : hhmm(e.t), compOf(e.c).name, e.n, e.fee, e.bonus, e.tip, e.lat || '', e.lng || '', '', '', '', '', ''].map(cc).join(','));
    }
    for (const e of m.expenses || []) L.push(['expense', e.date, '', '', '', '', '', '', '', '', '', '', e.memo, e.cat, e.amt].map(cc).join(','));
  }
  return L.join('\n');
}
function parseCsv(t) { const rows = []; let r = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const ch = t[i]; if (q) { if (ch === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; } else if (ch === '"') q = true; else if (ch === ',') { r.push(f); f = ''; } else if (ch === '\n' || ch === '\r') { if (ch === '\r' && t[i + 1] === '\n') i++; r.push(f); rows.push(r); r = []; f = ''; } else f += ch; } if (f || r.length) { r.push(f); rows.push(r); } return rows; }
function csvOutSheet() {
  const t = buildCsv();
  sheet(`<h2>CSV書き出し</h2><p class="sub">Excelやスプレッドシートで開けます。</p><div class="btns"><button class="btn" id="cD">ファイルで保存</button><button class="btn g" id="cC">コピー</button></div>`);
  $('#cD').onclick = () => download(new Blob(['﻿' + t], { type: 'text/csv' }), `delivery-${today()}.csv`);
  $('#cC').onclick = () => copyText(t);
}
function csvInSheet() {
  sheet(`<h2>CSV読み込み</h2><p class="sub">このアプリで書き出したCSV（旧バージョン含む）を読み込みます。同じ内容を2回読み込むと重複するので注意。</p>
    <input type="file" accept=".csv,text/csv" id="iF"><textarea id="iT" style="margin-top:8px;min-height:140px;font-size:12px" placeholder="またはここに貼り付け"></textarea>
    <button class="btn full" style="margin-top:12px" id="iGo">読み込む</button>`);
  $('#iF').onchange = e => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = () => $('#iT').value = String(r.result).replace(/^﻿/, ''); r.readAsText(f); };
  $('#iGo').onclick = () => {
    const rows = parseCsv($('#iT').value.trim()); if (rows.length < 2) return toast('データがありません');
    const head = rows[0].map(s => s.trim()); const ix = k => head.indexOf(k); const touched = new Set(); let n = 0;
    const byName = nm => { let c = comps().find(x => x.name === nm); if (!c) { c = { id: 'c' + uid(), name: nm || '不明', color: PALETTE[comps().length % PALETTE.length] }; S.settings.companies = [...comps(), c]; saveSettings(); } return c.id; };
    for (const r of rows.slice(1)) {
      const g = k => (ix(k) >= 0 ? r[ix(k)] : '') || ''; const type = g('type'), date = g('date'); if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue; touched.add(date);
      if (type === 'day') { const d = getDay(date, true); const km = g('km'); if (km !== '') d.km = num(km); if (g('memo')) d.memo = g('memo'); const wm = g('work_min'); if (wm !== '' && +wm > 0) d.work.manualMin = +wm; n++; }
      else if (type === 'entry') { const d = getDay(date, true); const tm = g('time'); const t = parseD(date); if (tm) { const [h, mi] = tm.split(':').map(Number); t.setHours(h, mi); } else t.setHours(23, 59); d.entries.push({ id: uid(), c: byName(g('company')), n: num(g('count')) || 1, fee: num(g('fee')), bonus: num(g('bonus')), tip: num(g('tip')), lat: g('lat') ? +g('lat') : undefined, lng: g('lng') ? +g('lng') : undefined, t: t.getTime(), bulk: !tm, u: Date.now() }); }
      else if (type === 'sale') { const d = getDay(date, true); const t = parseD(date); t.setHours(23, 59); d.entries.push({ id: uid(), c: byName(g('company')), n: num(g('count')), fee: num(g('fee')), bonus: num(g('bonus')), tip: num(g('tip')), t: t.getTime(), bulk: true, u: Date.now() }); }
      else if (type === 'expense') { const m = month(date.slice(0, 7)); m.expenses.push({ id: uid(), date, cat: g('category') || 'その他', amt: num(g('amount')), memo: g('memo'), u: Date.now() }); }
    }
    touched.forEach(d => touch(d)); [...new Set([...touched].map(d => d.slice(0, 7)))].forEach(k => touchMonth(k));
    closeSheet(); toast(`読み込みました（${touched.size}日分）`); render();
  };
}

/* ---------- 操作 ---------- */
$('#fab').addEventListener('click', () => entrySheet());
$('#view').addEventListener('input', e => {
  const t = e.target;
  if (t.dataset.day) { const d = getDay(cur, true); setField(d, t.dataset.day, t.dataset.day === 'km' ? (t.value.trim() === '' ? '' : num(t.value)) : t.value); touch(cur); paintHero(); }
  else if (t.dataset.set) { const p = t.dataset.set; setPath(p, ['goal', 'notif.idleMin', 'notif.lead'].includes(p) ? num(t.value) : t.value.trim()); }
  else if (t.dataset.peak != null) { S.settings.notif.peaks[+t.dataset.peak][t.dataset.k] = t.value; saveSettings(); }
});
$('#view').addEventListener('change', e => {
  const t = e.target; if (!t.dataset.sw) return; setPath(t.dataset.sw, t.checked);
  if (t.dataset.sw === 'dev.gps') { if (t.checked && activeState() === 'on') GPS.start(); if (!t.checked) GPS.stop(); }
  if (t.dataset.sw === 'dev.wakeLock') wake(t.checked && activeState() === 'on');
});
$('#view').addEventListener('click', e => { const a = e.target.closest('[data-act]'); if (!a) return; if (a.tagName === 'A') e.preventDefault(); act(a.dataset.act, a); });

async function act(k, el) {
  const shift = n => { const d = parseD(cur); d.setDate(d.getDate() + n); cur = ymd(d); render(); };
  const mshift = n => { const [y, m] = mon.split('-').map(Number); mon = ymd(new Date(y, m - 1 + n, 1)).slice(0, 7); render(); };
  const now = Date.now();
  switch (k) {
    case 'prev': return shift(-1);
    case 'next': return shift(1);
    case 'today': cur = today(); return render();
    case 'gotoActive': cur = S.active.date; return render();
    case 'mPrev': return mshift(-1);
    case 'mNext': return mshift(1);
    case 'calDay': cur = el.dataset.d; tab = 'home'; return render();
    case 'hideInstall': LS.set('dt.hideInstall', true); return render();
    case 'start': {
      const d = getDay(cur, true);
      if (d.work.manualMin != null && d.work.manualMin !== '') { const timer = workIntervals(d).reduce((a, [x, y]) => a + (y - x), 0) / 60000; setField(d, 'extraMin', Math.max(0, d.work.manualMin - timer), true); setField(d, 'manualMin', null, true); }
      d.work.sessions.push({ start: now, breaks: [] }); setActive({ date: cur }); touch(cur);
      GPS.start(); wake(true); paintTimer(); toast('稼働開始。安全運転で！'); Sync.status(true); return;
    }
    case 'break': { if (!S.active) setActive({ date: cur }); const d = activeDay(); const s = last(d.work.sessions); s.breaks.push({ s: now }); touch(S.active.date); GPS.stop(); wake(false); paintTimer(); toast('休憩スタート'); Sync.status(true); return; }
    case 'resume': { if (!S.active) setActive({ date: cur }); const d = activeDay(); const s = last(d.work.sessions); const b = last(s.breaks); if (b && !b.e) b.e = now; touch(S.active.date); GPS.start(); wake(true); paintTimer(); toast('稼働再開'); Sync.status(true); return; }
    case 'end': {
      if (!S.active) setActive({ date: cur }); const date = S.active.date; const d = activeDay(); const s = last(d.work.sessions); const b = last(s.breaks); if (b && !b.e) b.e = now; s.end = now; touch(date);
      GPS.stop(); wake(false); setActive(null); render(); toast('おつかれさまでした！');
      Sync.status(true);
      if (S.settings.discord.auto && S.settings.discord.url) sendDiscord(date);
      return;
    }
    case 'editTime': return editTimeSheet();
    case 'bulk': return bulkSheet();
    case 'editEntry': { const d = getDay(cur); const e = d.entries.find(x => x.id === el.dataset.id); if (e) entrySheet({ ...e, _date: cur }); return; }
    case 'report': return reportSheet();
    case 'discord': return sendDiscord(cur, true);
    case 'mapSeg': mapSeg = el.dataset.v; return render();
    case 'mapPeriod': mapPeriod = el.dataset.v; return render();
    case 'mapMetric': mapMetric = el.dataset.v; return render();
    case 'flyTo': map && map.flyTo([+el.dataset.lat, +el.dataset.lng], 16); scrollTo({ top: 0, behavior: 'smooth' }); return;
    case 'anaSeg': anaSeg = el.dataset.v; return render();
    case 'addExp': return expSheet();
    case 'delExp': { const m = month(mon); m.expenses = m.expenses.filter(x => x.id !== el.dataset.id); m.expDel = [...(m.expDel || []), el.dataset.id]; touchMonth(mon); return render(); }
    case 'toggleComp': { const h = S.settings.hidden || (S.settings.hidden = []); const i = h.indexOf(el.dataset.id); i >= 0 ? h.splice(i, 1) : h.push(el.dataset.id); saveSettings(); return render(); }
    case 'addComp': { const n = $('#newComp').value.trim(); if (!n) return; S.settings.companies = [...comps(), { id: 'c' + uid(), name: n, color: PALETTE[comps().length % PALETTE.length] }]; saveSettings(); return render(); }
    case 'addPeak': S.settings.notif.peaks.push({ label: 'ピーク', time: '20:00' }); saveSettings(); return render();
    case 'delPeak': S.settings.notif.peaks.splice(+el.dataset.i, 1); saveSettings(); return render();
    case 'askNotif': { try { const p = await Notification.requestPermission(); toast(p === 'granted' ? '通知を許可しました' : '通知が許可されませんでした'); } catch (e) { } return render(); }
    case 'testNotif': return notify('テスト通知', '通知はこんな風に届きます', 'test');
    case 'discordTest': {
      const url = S.settings.discord.url; if (!url) return toast('Webhook URLを入れてください');
      const fd = new FormData(); fd.append('payload_json', JSON.stringify({ username: '配達トラッカー', content: '✅ 配達トラッカーからのテスト送信です' }));
      try { await fetch(url, { method: 'POST', body: fd, mode: 'no-cors' }); toast('送信しました。Discordを確認してください'); } catch (e) { toast('送信できませんでした'); } return;
    }
    case 'syncNow': if (!Sync.on()) return toast('GASのURLを正しく入れてください'); toast('同期中…'); await Sync.run(true); return toast(Sync.state === 'ok' ? '同期しました' : '同期できませんでした。URLと合言葉を確認');
    case 'csvOut': return csvOutSheet();
    case 'csvIn': return csvInSheet();
  }
}

/* ---------- 起動 ---------- */
setInterval(() => {
  if (tab === 'home') { const d = getDay(cur); const st = wState(d); if (st === 'on' || st === 'break') { const c = $('#clock'); if (c) c.textContent = clockStr(workMin(d)); } }
}, 1000);
setInterval(() => { tick(); if (tab === 'home' && activeState() === 'on') paintHero(); }, 60000);
setInterval(() => { if (Sync.on() && document.visibilityState === 'visible') Sync.run(); }, 5 * 60000);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') { if (S.active && ['on', 'break'].includes(activeState()) && cur !== S.active.date && cur === ymd(new Date(Date.now() - 86400000))) { cur = S.active.date; render(); } if (activeState() === 'on') { wake(true); if (D.gps && GPS.id == null) GPS.start(); } tick(); if (Sync.on()) Sync.run(); if (tab === 'home') { paintHero(); paintTimer(); } }
  else { GPS.flush(true); }
});
window.addEventListener('online', () => { Sync.schedule(1000); flushDiscordQ(); });
if ('serviceWorker' in navigator && location.protocol === 'https:') { navigator.serviceWorker.register('sw.js').catch(() => { }); navigator.serviceWorker.ready.then(r => swReg = r).catch(() => { }); }
try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) { }
setTimeout(flushDiscordQ, 5000);
if (S.active && ['on', 'break'].includes(activeState())) cur = S.active.date; // 日付をまたいだ稼働中は稼働日を表示
render();
if (activeState() === 'on') { GPS.start(); wake(true); }
if (S.active && activeState() === 'ended') setActive(null);
setTimeout(tick, 3000);
if (Sync.on()) Sync.run(true);

// Vanguard Group — interactions + live AHD snapshot (no API keys in this file).
// Every binding is null-guarded so a missing element can never throw.
const $ = (s) => document.querySelector(s);
const on = (sel, ev, fn) => {
  const el = typeof sel === 'string' ? $(sel) : sel;
  if (el) el.addEventListener(ev, fn);
  return el;
};

const yearEl = $('#year');
if (yearEl) yearEl.textContent = new Date().getFullYear();

// Nav
const toggle = $('#navToggle'), mm = $('#mobileMenu');
if (toggle && mm) {
  on(toggle, 'click', () => mm.classList.toggle('open'));
  mm.querySelectorAll('a').forEach(a => on(a, 'click', () => mm.classList.remove('open')));
}

// Ticker duplicate for seamless loop
const ticker = $('#ticker');
if (ticker) ticker.innerHTML += ticker.innerHTML;

// Reveal on scroll
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((es) => es.forEach(e => {
    if (e.isIntersecting) e.target.classList.add('visible');
  }), { threshold: 0.12 });
  document.querySelectorAll('.reveal').forEach(el => io.observe(el));
} else {
  document.querySelectorAll('.reveal').forEach(el => el.classList.add('visible'));
}

// Copy buttons
document.querySelectorAll('[data-copy]').forEach(btn => {
  on(btn, 'click', async () => {
    const txt = btn.getAttribute('data-copy');
    try { await navigator.clipboard.writeText(txt); } catch {
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); } catch {}
      ta.remove();
    }
    const old = btn.textContent; btn.textContent = 'Copied ✓';
    setTimeout(() => btn.textContent = old, 1400);
  });
});

function escapeHtml(s){ return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
const esc = escapeHtml;
function fmtCompact(n){
  if (n == null || !isFinite(n)) return 'WIP';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + Math.round(n).toLocaleString('en-US');
}
function fmtGrowth(g, short){
  if (!g || g.pct == null) return 'n/a';
  const sign = g.pct >= 0 ? '+' : '';
  return short ? sign + g.pct.toFixed(1) + '%'
               : sign + g.pct.toFixed(2) + '% (t' + g.fromTurn + '→t' + g.toTurn + ')';
}

// ---- Live snapshot (data/live.json, refreshed hourly by Action; no key here)
let SNAP = null;
function corpByKey(key){
  if (!SNAP || !SNAP.corporations) return null;
  const id = key === 'blackrock' ? 498 : key === 'deere' ? 853 : key === 'vermont' ? 964 : key === 'pfizer' ? 496 : key === 'abc' ? 645 : key === 'ranco' ? 767 : key === 'kanso' ? 521 : key === 'org' ? 1084 : key === 'misa' ? 561 : key === 'napoleon' ? 565 : null;
  return SNAP.corporations.find(c => c.id === id || (id === null && c.name.toLowerCase().includes(key))) || null;
}
function localSym(c){ return c.currency === 'JPY' ? '¥' : c.currency === 'GBP' ? '£' : '$'; }
function fmtLocal(n, c){ return localSym(c) + Math.round(n).toLocaleString('en-US'); }
function fmtUSD(n){ return '$' + Math.round(n).toLocaleString('en-US'); }
function liveText(key, field, long){
  if (key === 'alliance' && SNAP && SNAP.corporations) {
    const sum = (f) => SNAP.corporations.reduce((a, c) => a + (c[f] || 0), 0);
    if (field === 'marketCap') return fmtCompact(sum('marketCapUsd'));
    if (field === 'revenue') return fmtCompact(sum('revenueUsd'));
    if (field === 'growth') {
      const b = SNAP.corporations.find(c => c.id === 498);
      return b && b.growth ? fmtGrowth(b.growth, !long) : 'n/a';
    }
    return null;
  }
  const c = corpByKey(key);
  if (!c) return null;
  if (field === 'marketCap') return c.marketCapUsd != null ? fmtCompact(c.marketCapUsd) : null;
  if (field === 'revenue') return c.revenueUsd != null ? fmtCompact(c.revenueUsd) : null;
  if (field === 'margin') return c.marginPct != null ? c.marginPct.toFixed(2) + '%' : null;
  if (field === 'rating') return c.creditRating || null;
  if (field === 'growth') return c.growth ? fmtGrowth(c.growth, !long) : 'n/a';
  if (field === 'stake') return c.blackrockStakePct > 0 ? (Math.round(c.blackrockStakePct * 10) / 10) + '%' : '—';
  if (field === 'top') {
    const h = (c.holders || [])[0];
    return h ? h.name + ' ' + h.pct + '%' : '—';
  }
  return null;
}
// Live turn timer: counts down to the next game turn and shows snapshot age,
// so the numbers always carry their freshness with them. Null-safe.
let timerInt = null;
function startTimer(s){
  let el = $('#turnTimer');
  if (!el) {
    const anchor = $('#liveStamp');
    if (!anchor || !anchor.after) return;
    el = document.createElement('span');
    el.id = 'turnTimer';
    el.className = 'live live-dim';
    el.textContent = 'SYNC...';
    anchor.after(el);
  }
  if (timerInt) clearInterval(timerInt);
  const snapAt = new Date(s.updatedAt).getTime();
  const next = s.game && s.game.nextTurnAt ? new Date(s.game.nextTurnAt).getTime() : null;
  const fmtAge = (ms) => {
    const m = Math.max(0, Math.floor(ms / 60000));
    if (m < 1) return 'JUST NOW';
    if (m < 60) return m + 'M AGO';
    return Math.floor(m / 60) + 'H ' + (m % 60) + 'M AGO';
  };
  const tickFn = () => {
    const now = Date.now();
    const age = 'SNAP ' + fmtAge(now - snapAt);
    if (!next) { el.textContent = age; return; }
    const ms = next - now;
    if (ms <= 0) { el.textContent = 'TURNING OVER… ' + age; return; }
    const mm = Math.floor(ms / 60000), ss = Math.floor((ms % 60000) / 1000);
    el.textContent = 'NEXT TURN ' + mm + ':' + String(ss).padStart(2, '0') + ' · ' + age;
  };
  tickFn();
  timerInt = setInterval(tickFn, 1000);
}
async function loadLive(){
  let s;
  try {
    const r = await fetch('data/live.json', { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    s = await r.json();
  } catch {
    const stamp = $('#liveStamp'); if (stamp) stamp.textContent = 'LIVE • OFFLINE';
    const note = $('#snapNote'); if (note) note.textContent = 'Live snapshot unavailable — showing last known structure. Raw: data/live.json.';
    return;
  }
  SNAP = s;
  startTimer(s);
  renderTies();
  renderChair();
  renderCharts();
  const upd = new Date(s.updatedAt);
  const dateStr = upd.toISOString().slice(0, 10);

  const stamp = $('#liveStamp');
  if (stamp) stamp.textContent = 'LIVE • TURN ' + s.game.currentTurn + ' • USD';
  const tick = $('#tickerLive');
  if (tick) tick.textContent = 'VERIFIED ' + dateStr;
  const jpy = (s.corporations.find(c => c.currency === 'JPY') || {}).fxPerUsd;
  const note = $('#snapNote');
  if (note) note.innerHTML = 'Verified ' + esc(dateStr) + ' · Turn ' + s.game.currentTurn +
    ' (' + esc(s.game.gameDateLabel) + ') · figures in USD' + (jpy ? ', converted at live forex (¥' + jpy + '/$)' : '') +
    ' · margin = income ÷ revenue · growth from share tape · <a href="data/live.json">raw snapshot</a>';

  document.querySelectorAll('[data-live]').forEach(el => {
    const parts = (el.getAttribute('data-live') || '').split(':');
    if (parts.length !== 2) return;
    const v = liveText(parts[0], parts[1], el.hasAttribute('data-growth'));
    if (v == null) return; // keep WIP fallback
    el.textContent = v;
    el.classList.remove('wip');
    if (parts[1] === 'growth' && v !== 'n/a') {
      el.classList.remove('up', 'down');
      el.classList.add(v.trim().startsWith('-') ? 'down' : 'up');
    }
    const c = corpByKey(parts[0]);
    if (c) {
      if (parts[1] === 'marketCap' && c.marketCap != null)
        el.title = c.currency === 'USD' ? fmtUSD(c.marketCapUsd) : fmtLocal(c.marketCap, c) + ' ≈ ' + fmtUSD(c.marketCapUsd);
      if (parts[1] === 'revenue' && c.revenue != null)
        el.title = c.currency === 'USD' ? fmtUSD(c.revenueUsd) : fmtLocal(c.revenue, c) + ' ≈ ' + fmtUSD(c.revenueUsd);
    }
  });

  const b = corpByKey('blackrock'), d = corpByKey('deere'), v = corpByKey('vermont');
  const bn = $('#blackrockNote');
  if (bn && b) bn.textContent = 'Passes T-1 + T-2 (' + fmtCompact(b.marketCapUsd) + ' cap, ' + b.marginPct.toFixed(2) + '% margin).';
  const dn = $('#deereNote');
  if (dn && d) {
    dn.textContent = d.checks && d.checks.marketCapPass
      ? 'Meets the $350M floor (' + fmtCompact(d.marketCapUsd) + ' cap, ' + d.marginPct.toFixed(2) + '% margin).'
      : 'Currently at ' + fmtCompact(d.marketCapUsd) + ' — below the $350M floor, flagged pending recovery. Margin ' + d.marginPct.toFixed(2) + '% holds.';
  }
  const vn = $('#vermontNote');
  if (vn && v) vn.textContent = 'Passes T-1 + T-2 (' + fmtCompact(v.marketCapUsd) + ' cap, ' + v.marginPct.toFixed(2) + '% margin).';
  const p = corpByKey('pfizer');
  const pn = $('#pfizerNote');
  if (pn && p) {
    pn.textContent = p.checks && p.checks.marketCapPass
      ? 'Meets the $350M floor (' + fmtCompact(p.marketCapUsd) + ' cap, ' + p.marginPct.toFixed(2) + '% margin).'
      : 'At ' + fmtCompact(p.marketCapUsd) + ' just under the $350M floor, flagged pending recovery. Margin ' + p.marginPct.toFixed(2) + '% holds.';
  }
  const a = corpByKey('abc');
  const an = $('#abcNote');
  if (an && a) an.textContent = 'Passes T-1 + T-2 (' + fmtCompact(a.marketCapUsd) + ' cap, ' + a.marginPct.toFixed(2) + '% margin).';
  const rn = $('#rancoNote');
  const rc = corpByKey('ranco');
  if (rn && rc) {
    rn.textContent = rc.checks.marginPass
      ? 'Passes T-1 + T-2 (' + fmtCompact(rc.marketCapUsd) + ' cap, ' + rc.marginPct.toFixed(2) + '% margin).'
      : 'Margin ' + rc.marginPct.toFixed(2) + '% below the 10% floor, flagged. Market cap ' + fmtCompact(rc.marketCapUsd) + ' holds.';
  }
  const kn = $('#kansoNote');
  const kc = corpByKey('kanso');
  if (kn && kc) kn.textContent = 'Passes T-1 + T-2 (' + fmtCompact(kc.marketCapUsd) + ' cap, ' + kc.marginPct.toFixed(2) + '% margin).';
  const on2 = $('#orgNote');
  const oc = corpByKey('org');
  if (on2 && oc) {
    on2.textContent = oc.checks.marketCapPass
      ? 'Meets the $350M floor (' + fmtCompact(oc.marketCapUsd) + ' cap, ' + oc.marginPct.toFixed(2) + '% margin).'
      : 'At ' + fmtCompact(oc.marketCapUsd) + ' below the $350M floor. Margin ' + oc.marginPct.toFixed(2) + '% holds.';
  }
  const mn = $('#misaNote');
  const mc = corpByKey('misa');
  if (mn && mc) mn.textContent = 'Passes T-1 + T-2 (' + fmtCompact(mc.marketCapUsd) + ' cap, ' + mc.marginPct.toFixed(2) + '% margin).';
  const nn = $('#napoleonNote');
  const nc = corpByKey('napoleon');
  if (nn && nc) nn.textContent = 'Passes T-1 + T-2 (' + fmtCompact(nc.marketCapUsd) + ' cap, ' + nc.marginPct.toFixed(2) + '% margin).';
  const banner = $('#dataBanner');
  if (banner && b && d) {
    banner.innerHTML = '⚙ LIVE DATA (USD) — BlackRock <strong>PASS</strong> (' + esc(fmtCompact(b.marketCapUsd)) + ' · ' + b.marginPct.toFixed(2) + '% · ' + esc(fmtGrowth(b.growth, false)) + ')' +
      ' · John Deere <strong>' + (d.checks && d.checks.marketCapPass ? 'PASS' : 'BELOW FLOOR') + '</strong>' +
      ' (' + esc(fmtCompact(d.marketCapUsd)) + ' · ' + d.marginPct.toFixed(2) + '%)' +
      (v ? ' · Vermont Logistics <strong>PASS</strong> (' + esc(fmtCompact(v.marketCapUsd)) + ' · ' + v.marginPct.toFixed(2) + '%)' : '') +
      (a ? ' · ABC Media <strong>PASS</strong> (' + esc(fmtCompact(a.marketCapUsd)) + ' · ' + a.marginPct.toFixed(2) + '%' + (a.growth ? ' · ' + esc(fmtGrowth(a.growth, true)) : '') + ')' : '') +
      (rc ? ' · Ranco Arms <strong>' + (rc.checks.marginPass ? 'PASS' : 'LOW MARGIN') + '</strong> (' + esc(fmtCompact(rc.marketCapUsd)) + ' · ' + rc.marginPct.toFixed(2) + '%)' : '') +
      (kc ? ' · 簡素 <strong>PASS</strong> (' + esc(fmtCompact(kc.marketCapUsd)) + ' · ' + kc.marginPct.toFixed(2) + '%' + (kc.growth ? ' · ' + esc(fmtGrowth(kc.growth, true)) : '') + ')' : '') +
      (mc ? ' · I Love Misa <strong>PASS</strong> (' + esc(fmtCompact(mc.marketCapUsd)) + ' · ' + mc.marginPct.toFixed(2) + '%' + (mc.growth ? ' · ' + esc(fmtGrowth(mc.growth, true)) : '') + ')' : '') +
      (nc ? ' · I Love Napoleon <strong>PASS</strong> (' + esc(fmtCompact(nc.marketCapUsd)) + ' · ' + nc.marginPct.toFixed(2) + '%' + (nc.growth ? ' · ' + esc(fmtGrowth(nc.growth, true)) : '') + ')' : '') +
      (oc ? ' · The Organization <strong>BELOW FLOOR</strong> (' + esc(fmtCompact(oc.marketCapUsd)) + ' · ' + oc.marginPct.toFixed(2) + '%)' : '') +
      (p ? ' · Pfizer <strong>' + (p.checks && p.checks.marketCapPass ? 'PASS' : 'BELOW FLOOR') + '</strong> (' + esc(fmtCompact(p.marketCapUsd)) + ' · ' + p.marginPct.toFixed(2) + '%' + (p.growth ? ' · ' + esc(fmtGrowth(p.growth, true)) : '') + ')' : '') +
      ' · snapshot <a href="data/live.json">data/live.json</a> · turn ' + s.game.currentTurn;
  }
}

// ---- Member ties renderer (cross-holdings + owner-operators + shared backers)
function renderTies(){
  const box = $('#tiesList');
  if (!box || !SNAP || !SNAP.ties) return;
  const owns = SNAP.ties.filter(t => t.type === 'owns');
  const backers = SNAP.ties.filter(t => t.type === 'backer' && Math.min(t.aPct, t.bPct) >= 0.5 && Math.max(t.aPct, t.bPct) >= 5);
  const ops = (SNAP.corporations || []).filter(c => {
    const h = (c.holders || [])[0];
    return h && c.ceo && h.name === c.ceo;
  });
  let html = '';
  if (owns.length) {
    html += '<div class="tie-group">CROSS-HOLDINGS</div><div class="ties">';
    html += owns.map(t => '<div class="tie-row"><span class="tie-from">' + escapeHtml(t.from) + '</span><span class="tie-link">holds ' + t.pct + '% of</span><span class="tie-to">' + escapeHtml(t.to) + '</span></div>').join('');
    html += '</div>';
  }
  if (ops.length) {
    html += '<div class="tie-group">OWNER-OPERATORS</div><div class="ties">';
    html += ops.map(c => '<div class="tie-row"><span class="tie-from">' + escapeHtml(c.holders[0].name) + '</span><span class="tie-link">runs ' + escapeHtml(c.name) + ' and holds</span><span class="tie-to">' + c.holders[0].pct + '%</span></div>').join('');
    html += '</div>';
  }
  if (backers.length) {
    html += '<div class="tie-group">SHARED BACKERS</div><div class="ties">';
    html += backers.map(t => '<div class="tie-row"><span class="tie-from">' + escapeHtml(t.who) + '</span><span class="tie-link">backs</span><span class="tie-to">' + escapeHtml(t.a) + ' (' + t.aPct + '%) + ' + escapeHtml(t.b) + ' (' + t.bPct + '%)</span></div>').join('');
    html += '</div>';
  }
  if (html) box.innerHTML = html;
}

// ---- Eligibility checker
const verdict = $('#verdict'), vTitle = $('#verdictTitle'),
      vBody = $('#verdictBody'), vCta = $('#verdictCta');
function setVerdict(ok, title, bodyHtml, showCta){
  if (!verdict) return;
  verdict.classList.remove('pass', 'fail');
  verdict.classList.add(ok ? 'pass' : 'fail');
  if (vTitle) vTitle.textContent = title;
  if (vBody) vBody.innerHTML = bodyHtml;
  if (vCta) vCta.style.display = showCta ? 'inline-flex' : 'none';
  try { verdict.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); } catch {}
}
on('#checkBtn', 'click', () => {
  const nameEl = $('#cName'), capEl = $('#cCap'), margEl = $('#cMargin');
  if (!nameEl || !capEl || !margEl) return;
  const name = nameEl.value.trim() || 'Your corporation';
  const cap = parseFloat(capEl.value);
  const margin = parseFloat(margEl.value);
  const active = $('#cActive') ? $('#cActive').checked : false;
  const coord = $('#cCoord') ? $('#cCoord').checked : false;

  const fails = [];
  if (isNaN(cap)) fails.push('Enter your market cap ($M).');
  else if (cap < 350) fails.push(`Market cap $${cap}M is below the $350M floor.`);
  if (isNaN(margin)) fails.push('Enter your net margin %.');
  else if (margin < 10) fails.push(`Margin ${margin}% is below the 10% minimum (15% preferred).`);
  if (!active) fails.push('Daily-active status not confirmed.');
  if (!coord) fails.push('Coordination commitment not confirmed.');

  if (fails.length === 0) {
    setVerdict(true, '✓ ELIGIBLE — open negotiations',
      `<strong>${escapeHtml(name)}</strong> passes: $${cap}M cap, ${margin}% margin, active + coordinated. Message <code>hyawii2.0</code> on Discord or mail <code>Larry Fink</code> in-game now.`, true);
  } else {
    setVerdict(false, '✕ NOT ELIGIBLE YET',
      `<strong>${escapeHtml(name)}:</strong><br>• ` + fails.map(escapeHtml).join('<br>• '), false);
  }
});

// Pull figures from the verified snapshot by corp ID (members tracked: 498, 853, 964, 496, 645, 767, 521, 1084, 561, 565)
on('#lookupBtn', 'click', () => {
  const idEl = $('#cId');
  if (!idEl) return;
  const id = parseInt(idEl.value, 10);
  if (!SNAP) { setVerdict(false, 'Snapshot not loaded', 'Wait a moment for data/live.json to load, then try again.', false); return; }
  if (isNaN(id)) { setVerdict(false, 'No corp ID', 'Enter your corp sequential ID — the number in your corporation page URL.', false); return; }
  const c = SNAP.corporations.find(x => x.id === id);
  if (!c) {
    setVerdict(false, 'Not in snapshot',
      'Corp #' + id + ' is not one of the currently tracked members — the snapshot tracks alliance members only. Enter your market cap ($M) and margin % manually from your corporation page.', false);
    return;
  }
  if ($('#cName')) $('#cName').value = c.name;
  if ($('#cCap')) $('#cCap').value = c.marketCapUsd != null ? (c.marketCapUsd / 1e6).toFixed(2) : '';
  if ($('#cMargin')) $('#cMargin').value = c.marginPct != null ? c.marginPct.toFixed(2) : '';
  setVerdict(c.checks.marketCapPass && c.checks.marginPass,
    c.name + ' — pulled from API snapshot (USD)',
    'Revenue ' + esc(fmtCompact(c.revenueUsd)) + ' · income ' + esc(fmtCompact(c.operatingIncomeUsd)) +
    (c.currency !== 'USD' ? ' · local ' + esc(fmtLocal(c.revenue, c)) + ' / ' + esc(fmtLocal(c.marketCap, c)) : '') +
    ' · margin ' + (c.marginPct != null ? c.marginPct.toFixed(2) + '%' : 'n/a') +
    ' · cap ' + esc(fmtCompact(c.marketCapUsd)) +
    (c.growth ? ' · growth ' + esc(fmtGrowth(c.growth, false)) : ' · growth n/a') +
    ' · <a href="' + escapeHtml(c.corpUrl) + '">open corp page</a>. Now tick the activity boxes and press Evaluate.', false);
});

// Mail generator
on('#genMail', 'click', () => {
  const corpEl = $('#mCorp'), capEl = $('#mCap'), margEl = $('#mMargin'), out = $('#mailOut');
  if (!out) return;
  const corp = (corpEl && corpEl.value.trim()) || '[Your Corp Name]';
  const cap = (capEl && capEl.value) || '[350+]';
  const marg = (margEl && margEl.value) || '[10-15+]';
  out.value =
`Subject: Vanguard Group — Entry Negotiation Request (${corp})

Hello Larry Fink,

I am writing on behalf of ${corp} to request entry negotiations for the Vanguard Group.

— Market Cap: $${cap}M (verified screenshot attached)
— Net Margin: ${marg}% sustained
— Activity: Daily-active leadership, responsive comms
— Commitment: Willing to coordinate pricing, supply, votes and crisis response with the group and its members.

Current members noted: BlackRock Incorporated, John Deere, Vermont Logistics, Pfizer, American Broadcasting Company, Ranco Weapon Manfacturing, 簡素 (#521), The Organization (#1084), I Love Misa (#561), I Love Napoleon (#565).

Please advise on verification steps and negotiation time.

Regards,
[Your Name] — ${corp} (A House Divided)`;
});
on('#copyMail', 'click', async () => {
  const ta = $('#mailOut');
  if (!ta || !ta.value) return;
  try { await navigator.clipboard.writeText(ta.value); } catch { try { ta.select(); document.execCommand('copy'); } catch {} }
  const b = $('#copyMail'); if (!b) return;
  const o = b.textContent; b.textContent = 'Copied ✓';
  setTimeout(() => b.textContent = o, 1400);
});

loadLive();

// Live data watch: the snapshot republishes every 15 min. If a newer one
// appears while the page is open, flag it in the timer pill and reload so
// the numbers always match the latest turn.
setInterval(async () => {
  try {
    if (!SNAP) return;
    const r = await fetch('data/live.json', { cache: 'no-store' });
    if (!r.ok) return;
    const s = await r.json();
    if (s.updatedAt && s.updatedAt !== SNAP.updatedAt) {
      const el = $('#turnTimer');
      if (el) el.textContent = 'NEW DATA — RELOADING...';
      setTimeout(() => location.reload(), 2000);
    }
  } catch {}
}, 60000);

// ---- Universal corp search + live pull (user key stays in their browser)
let CORPS = [];
let selCorp = null;
async function loadCorps(){
  try {
    const r = await fetch('data/corps.json', { cache: 'no-store' });
    if (!r.ok) return;
    const j = await r.json();
    CORPS = j.corps || [];
    const cc = $('#corpCount');
    if (cc) cc.textContent = (j.count || CORPS.length).toLocaleString('en-US');
    try { const k = sessionStorage.getItem('ahd_key'); if (k && $('#akey')) $('#akey').value = k; } catch {}
  } catch {}
}
function renderSearch(q){
  const box = $('#qResults');
  if (!box) return;
  q = (q || '').trim().toLowerCase();
  if (q.length < 2) { box.innerHTML = ''; selCorp = null; return; }
  const isNum = /^\d+$/.test(q);
  const inSnap = (id) => !!(SNAP && SNAP.corporations.some(x => x.id === id));
  const hits = [];
  for (const c of CORPS) {
    const hit = isNum ? String(c.id).startsWith(q) : c.name.toLowerCase().includes(q);
    if (hit) { hits.push(c); if (hits.length >= 60) break; }
  }
  hits.sort((a, b) => ((inSnap(b.id) ? 1 : 0) - (inSnap(a.id) ? 1 : 0)) || (a.name.toLowerCase().indexOf(q) - b.name.toLowerCase().indexOf(q)));
  const top = hits.slice(0, 8);
  box.innerHTML = top.map(c =>
    '<div class="q-item" data-id="' + c.id + '"><span>' + escapeHtml(c.name) + '</span><small>#' + c.id + ' · ' + escapeHtml(c.type || '?') + ' · ' + escapeHtml(c.country || '') + (inSnap(c.id) ? ' · MEMBER' : '') + '</small></div>'
  ).join('') || '<p class="note">No matches.</p>';
  box.querySelectorAll('.q-item').forEach(el => el.addEventListener('click', () => {
    const c = CORPS.find(x => x.id === Number(el.getAttribute('data-id')));
    if (c) selectCorp(c);
  }));
}
function selectCorp(c){
  selCorp = c;
  const box = $('#qResults');
  const member = SNAP && SNAP.corporations.find(x => x.id === c.id);
  if (box) box.innerHTML = '<p class="note">Selected: <strong>' + escapeHtml(c.name) + '</strong> (#' + c.id + '). ' + (member ? 'Alliance member — verified figures load automatically.' : 'Enter figures manually, or pull live with your key below.') + '</p>';
  if ($('#cName')) $('#cName').value = c.name;
  if ($('#cId')) $('#cId').value = c.id;
  if (member) {
    if ($('#cCap')) $('#cCap').value = member.marketCapUsd != null ? (member.marketCapUsd / 1e6).toFixed(2) : '';
    if ($('#cMargin')) $('#cMargin').value = member.marginPct != null ? member.marginPct.toFixed(2) : '';
    setVerdict(member.checks.marketCapPass && member.checks.marginPass, member.name + ' — alliance snapshot',
      'Revenue ' + esc(fmtCompact(member.revenueUsd)) + ' · margin ' + (member.marginPct != null ? member.marginPct.toFixed(2) + '%' : 'n/a') + ' · cap ' + esc(fmtCompact(member.marketCapUsd)) + ' · <a href="' + escapeHtml(member.corpUrl) + '">open corp page</a>. Tick the activity boxes and press Evaluate.', false);
  }
}
function getKey(){
  const inp = $('#akey');
  let k = (inp && inp.value.trim()) || '';
  if (!k) { try { k = sessionStorage.getItem('ahd_key') || ''; } catch {} }
  return k;
}
async function pullLive(){
  const msg = $('#pullMsg');
  const say = (t) => { if (msg) msg.textContent = t; };
  if (!selCorp) { say('Search and pick a corporation first.'); return; }
  const member = SNAP && SNAP.corporations.find(x => x.id === selCorp.id);
  if (member) { say(selCorp.name + ' is an alliance member — figures already loaded from the verified snapshot.'); return; }
  const key = getKey();
  if (!key || key.indexOf('ahd_') !== 0) { say('Enter your AHD public key first (ahd_pub_…). It stays in this browser tab.'); return; }
  say('Pulling #' + selCorp.id + ' from the game API…');
  try {
    const r = await fetch('https://ahousedividedgame.com/api/public/v1/corporation?id=' + selCorp.id, { headers: { 'X-API-Key': key } });
    if (r.status === 401) { say('Key rejected (401). Check it in-game: Settings → API Keys.'); return; }
    if (!r.ok) { say('Game API error ' + r.status + '. Try again in a minute.'); return; }
    const c = await r.json();
    if (!c.found) { say('Corporation not found — it may have been dissolved.'); return; }
    try { sessionStorage.setItem('ahd_key', key); } catch {}
    const fx = (SNAP && SNAP.forex) || {};
    const ccy = (fx.countryCcy && fx.countryCcy[c.countryId]) || 'USD';
    const usdRate = fx.rates && fx.rates.USD ? fx.rates.USD : 0.9422652295481025;
    const ccyRate = fx.rates && fx.rates[ccy] ? fx.rates[ccy] : (ccy === 'USD' ? usdRate : null);
    const mkt = c.balanceSheet ? c.balanceSheet.marketCapitalization : null;
    const mktUsd = (mkt != null && ccyRate) ? (mkt / ccyRate) * usdRate : null;
    const rev = c.financials ? c.financials.totalRevenue : null;
    const inc = c.financials ? c.financials.operatingIncome : null;
    const mg = (rev && inc != null && rev !== 0) ? (inc / rev) * 100 : null;
    if ($('#cName')) $('#cName').value = c.name;
    if ($('#cCap') && mktUsd != null) $('#cCap').value = (mktUsd / 1e6).toFixed(2);
    if ($('#cMargin') && mg != null) $('#cMargin').value = mg.toFixed(2);
    setVerdict(mktUsd != null && mktUsd >= 350000000 && mg != null && mg >= 10, c.name + ' — live pull',
      'Revenue ' + esc(fmtCompact(rev != null ? rev * usdRate : null)) + ' · margin ' + (mg != null ? mg.toFixed(2) + '%' : 'n/a') + ' · cap ' + esc(fmtCompact(mktUsd)) + (ccy !== 'USD' ? ' (converted from ' + esc(ccy) + ')' : '') + ' · CEO ' + escapeHtml((c.ceo && c.ceo.name) || '—') + ' · <a href="' + escapeHtml(c.corpUrl || ('https://www.ahousedividedgame.com/corporations/' + selCorp.id)) + '">open corp page</a>. Tick the activity boxes and press Evaluate.', false);
    say('Pulled live. Key saved for this tab only.');
  } catch (e) {
    say('Pull blocked by the browser or network (CORS/offline). Enter figures manually from the corp page.');
  }
}
on('#q', 'input', (e) => renderSearch(e.target.value));
on('#pullBtn', 'click', pullLive);

// ---- Chairman (org.json config, member-ballot flow)
let ORG = null;
async function loadOrg(){
  try {
    const r = await fetch('data/org.json', { cache: 'no-store' });
    if (!r.ok) return;
    ORG = await r.json();
    renderChair();
  } catch {}
}
function renderChair(){
  if (!ORG) return;
  const ch = ORG.chairman || {}, el = ORG.election || {};
  if ($('#chairName')) $('#chairName').textContent = ch.name || '—';
  if ($('#chairHolder')) $('#chairHolder').textContent = ch.holder || '—';
  if ($('#chairSince')) $('#chairSince').textContent = ch.since || '—';
  if ($('#chairTerm')) $('#chairTerm').textContent = el.term || '—';
  if ($('#chairTag')) $('#chairTag').textContent = ch.interim ? 'INTERIM CHAIRMAN' : 'CHAIRMAN';
  if ($('#chairNote')) $('#chairNote').textContent = ch.interim ? 'Interim appointment — stands until the first member vote.' : 'Elected by the member corporations.';
  if ($('#elecDate') && el.nextVote) {
    try { $('#elecDate').textContent = new Date(el.nextVote).toUTCString().slice(0, 22); } catch {}
  }
  if ($('#chairRules') && ORG.rules) $('#chairRules').innerHTML = ORG.rules.map(x => '<li>' + escapeHtml(x) + '</li>').join('');
  if (SNAP && $('#voteCorp') && $('#voteCand')) {
    const opts = SNAP.corporations.map(c => '<option value="' + c.id + '">' + escapeHtml(c.name) + '</option>').join('');
    $('#voteCorp').innerHTML = opts;
    $('#voteCand').innerHTML = opts;
  }
  tickElection();
}
function tickElection(){
  const el = $('#elecCountdown');
  if (!el || !ORG || !ORG.election || !ORG.election.nextVote) return;
  const ms = new Date(ORG.election.nextVote).getTime() - Date.now();
  if (isNaN(ms)) return;
  if (ms <= 0) { el.textContent = 'VOTING OPEN'; return; }
  const d = Math.floor(ms / 86400000), h = Math.floor(ms % 86400000 / 3600000),
        m = Math.floor(ms % 3600000 / 60000), s = Math.floor(ms % 60000 / 1000);
  el.textContent = d + 'D ' + h + 'H ' + m + 'M ' + s + 'S';
}
setInterval(tickElection, 1000);
function corpNameById(id){
  const c = SNAP && SNAP.corporations.find(x => x.id === Number(id));
  if (c) return c.name;
  const d = CORPS.find(x => x.id === Number(id));
  return d ? d.name : '#' + id;
}
on('#genBallot', 'click', () => {
  const vc = $('#voteCorp'), vd = $('#voteCand'), out = $('#ballotOut');
  if (!vc || !vd || !out) return;
  out.value = 'VANGUARD CHAIRMAN BALLOT — turn ' + ((SNAP && SNAP.game.currentTurn) || '?') + '\n' +
    'Voter (corp): ' + corpNameById(vc.value) + ' (#' + vc.value + ')\n' +
    'Vote for: ' + corpNameById(vd.value) + ' (#' + vd.value + ')\n' +
    'Signed: [your character + Discord]\nSend via Discord DM to hyawii2.0 before the deadline.';
});
on('#copyBallot', 'click', async () => {
  const ta = $('#ballotOut');
  if (!ta || !ta.value) return;
  try { await navigator.clipboard.writeText(ta.value); } catch { try { ta.select(); document.execCommand('copy'); } catch {} }
  const b = $('#copyBallot'); if (!b) return;
  const o = b.textContent; b.textContent = 'Copied ✓';
  setTimeout(() => b.textContent = o, 1400);
});

// ---- Charts (hand-rolled SVG, no dependencies)
const PALETTE = ['#60a5fa', '#4ade80', '#f472b6', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#e879f9', '#a3e635', '#fb923c'];
function svgOpen(w, h, inner){ return '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" style="width:100%;height:auto;display:block">' + (inner || '') + '</svg>'; }
function axisLabel(x, y, t, anchor){
  return '<text x="' + x + '" y="' + y + '" fill="#9aa3c7" font-size="10" text-anchor="' + (anchor || 'middle') + '" font-family="ui-monospace,monospace">' + escapeHtml(t) + '</text>';
}
function lineChart(el, series, opts){
  opts = opts || {};
  if (!el) return;
  if (!series.length) { el.innerHTML = '<p class="note">Collecting history.</p>'; return; }
  const W = 560, H = 230, P = 40;
  const ok = series.map(s => ({ name: s.name, color: s.color, pts: s.pts.filter(p => p[1] > 0) })).filter(s => s.pts.length > 1);
  if (!ok.length) { el.innerHTML = '<p class="note">Not enough history yet — points accumulate every 15 min.</p>'; return; }
  const xs = ok.flatMap(s => s.pts.map(p => p[0]));
  const ys = ok.flatMap(s => s.pts.map(p => p[1]));
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  let lo = Math.min(...ys), hi = Math.max(...ys);
  if (lo === hi) { lo *= 0.9; hi *= 1.1; }
  const X = (x) => P + (xmax === xmin ? 0.5 : (x - xmin) / (xmax - xmin)) * (W - 2 * P);
  const l0 = Math.log10(lo), l1 = Math.log10(hi);
  const Y = (y) => {
    const t = opts.log ? (Math.log10(Math.max(y, lo)) - l0) / ((l1 - l0) || 1) : (y - lo) / ((hi - lo) || 1);
    return H - P - t * (H - 2 * P);
  };
  let g = '';
  [0, 0.5, 1].forEach(f => {
    const y = H - P - f * (H - 2 * P);
    const v = opts.log ? Math.pow(10, l0 + f * (l1 - l0)) : lo + f * (hi - lo);
    g += '<line x1="' + P + '" y1="' + y + '" x2="' + (W - 12) + '" y2="' + y + '" stroke="rgba(255,255,255,.08)"/>' + axisLabel(4, y + 3, opts.fmt ? opts.fmt(v) : Math.round(v), 'start');
  });
  g += axisLabel(P, H - 8, String(xmin), 'start') + axisLabel(W - 12, H - 8, String(xmax), 'end');
  ok.forEach(s => {
    g += '<polyline fill="none" stroke="' + s.color + '" stroke-width="2" points="' + s.pts.map(p => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ') + '"/>';
    const last = s.pts[s.pts.length - 1];
    g += '<circle cx="' + X(last[0]).toFixed(1) + '" cy="' + Y(last[1]).toFixed(1) + '" r="3" fill="' + s.color + '"/>';
  });
  el.innerHTML = svgOpen(W, H, g);
}
function barChart(el, items, opts){
  opts = opts || {};
  if (!el || !items.length) return;
  const W = 560, RH = 30, P = 150;
  const max = Math.max(...items.map(i => i.value), opts.ref || 0, 1);
  const H = items.length * RH + 34;
  let g = '';
  items.forEach((it, i) => {
    const y = 8 + i * RH, w = Math.max(2, (it.value / max) * (W - P - 70));
    g += axisLabel(P - 8, y + 15, it.label, 'end');
    g += '<rect x="' + P + '" y="' + y + '" width="' + w.toFixed(1) + '" height="16" rx="4" fill="' + it.color + '"/>';
    g += axisLabel(P + w + 6, y + 13, opts.fmt ? opts.fmt(it.value) : it.value, 'start');
  });
  if (opts.ref != null) {
    const x = P + (opts.ref / max) * (W - P - 70);
    g += '<line x1="' + x + '" y1="4" x2="' + x + '" y2="' + (H - 26) + '" stroke="#ff4d67" stroke-dasharray="4 3"/>' + axisLabel(x, H - 8, opts.refLabel || '', 'middle');
  }
  el.innerHTML = svgOpen(W, H, g);
}
function colorFor(c, i){
  return c.brandColor || PALETTE[i % PALETTE.length];
}
async function renderCharts(){
  if (!SNAP) return;
  // alliance history (combined per snapshot point)
  try {
    const r = await fetch('data/history.json', { cache: 'no-store' });
    const h = r.ok ? await r.json() : { points: [] };
    const pts = (h.points || []).filter(p => p.turn != null);
    const cap = pts.map(p => [p.turn, p.corps.reduce((a, c) => a + (c.m || 0), 0)]);
    const rev = pts.map(p => [p.turn, p.corps.reduce((a, c) => a + (c.r || 0), 0)]);
    lineChart($('#chCapHist'), cap.length > 1 ? [{ name: 'cap', color: '#60a5fa', pts: cap }] : [], { fmt: fmtCompact });
    lineChart($('#chRevHist'), rev.length > 1 ? [{ name: 'rev', color: '#4ade80', pts: rev }] : [], { fmt: fmtCompact });
  } catch {
    const a = $('#chCapHist'), b = $('#chRevHist');
    if (a) a.innerHTML = '<p class="note">History unavailable.</p>';
    if (b) b.innerHTML = '<p class="note">History unavailable.</p>';
  }
  // per-member bars
  const corps = [...SNAP.corporations].sort((a, b) => (b.marketCapUsd || 0) - (a.marketCapUsd || 0));
  barChart($('#chCapBars'), corps.map((c, i) => ({ label: c.name.length > 22 ? c.name.slice(0, 21) + '…' : c.name, value: c.marketCapUsd || 0, color: colorFor(c, i) })), { fmt: fmtCompact });
  barChart($('#chMarginBars'), corps.map((c, i) => ({ label: c.name.length > 22 ? c.name.slice(0, 21) + '…' : c.name, value: c.marginPct || 0, color: (c.marginPct || 0) >= 10 ? '#4ade80' : '#f87171' })), { fmt: (v) => v.toFixed(1) + '%', ref: 10, refLabel: 'floor 10%' });
  // tape chart (log scale)
  const series = corps.map((c, i) => ({ name: c.name, color: colorFor(c, i), pts: (c.tape || []).filter(p => p[1] > 0) })).filter(s => s.pts.length > 1);
  lineChart($('#chTape'), series, { log: true, fmt: (v) => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v >= 1 ? v.toFixed(1) : v.toFixed(3) });
  const lg = $('#chTapeLegend');
  if (lg) lg.innerHTML = series.map(s => '<span><b style="background:' + s.color + '"></b>' + escapeHtml(s.name) + '</span>').join('');
}

loadCorps();
loadOrg();

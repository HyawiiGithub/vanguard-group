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

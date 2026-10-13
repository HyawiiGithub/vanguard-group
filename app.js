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
  const id = key === 'blackrock' ? 498 : key === 'deere' ? 853 : key === 'vermont' ? 964 : key === 'pfizer' ? 496 : key === 'abc' ? 645 : null;
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
  return null;
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
  const banner = $('#dataBanner');
  if (banner && b && d) {
    banner.innerHTML = '⚙ LIVE DATA (USD) — BlackRock <strong>PASS</strong> (' + esc(fmtCompact(b.marketCapUsd)) + ' · ' + b.marginPct.toFixed(2) + '% · ' + esc(fmtGrowth(b.growth, false)) + ')' +
      ' · John Deere <strong>' + (d.checks && d.checks.marketCapPass ? 'PASS' : 'BELOW FLOOR') + '</strong>' +
      ' (' + esc(fmtCompact(d.marketCapUsd)) + ' · ' + d.marginPct.toFixed(2) + '%)' +
      (v ? ' · Vermont Logistics <strong>PASS</strong> (' + esc(fmtCompact(v.marketCapUsd)) + ' · ' + v.marginPct.toFixed(2) + '%)' : '') +
      (a ? ' · ABC Media <strong>PASS</strong> (' + esc(fmtCompact(a.marketCapUsd)) + ' · ' + a.marginPct.toFixed(2) + '%' + (a.growth ? ' · ' + esc(fmtGrowth(a.growth, true)) : '') + ')' : '') +
      (p ? ' · Pfizer <strong>' + (p.checks && p.checks.marketCapPass ? 'PASS' : 'BELOW FLOOR') + '</strong> (' + esc(fmtCompact(p.marketCapUsd)) + ' · ' + p.marginPct.toFixed(2) + '%' + (p.growth ? ' · ' + esc(fmtGrowth(p.growth, true)) : '') + ')' : '') +
      ' · snapshot <a href="data/live.json">data/live.json</a> · turn ' + s.game.currentTurn;
  }
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

// Pull figures from the verified snapshot by corp ID (members tracked: 498, 853, 964, 496, 645)
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

Current members noted: BlackRock Incorporated, John Deere, Vermont Logistics, Pfizer, American Broadcasting Company.

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

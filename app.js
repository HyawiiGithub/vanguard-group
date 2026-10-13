// Vanguard Group — interactions
const $ = (s) => document.querySelector(s);

$('#year').textContent = new Date().getFullYear();

// Nav
const toggle = $('#navToggle'), mm = $('#mobileMenu');
toggle.addEventListener('click', () => mm.classList.toggle('open'));
mm.querySelectorAll('a').forEach(a => a.addEventListener('click', () => mm.classList.remove('open')));

// Ticker duplicate for seamless loop
const ticker = $('#ticker');
ticker.innerHTML += ticker.innerHTML;

// Reveal on scroll
const io = new IntersectionObserver((es) => es.forEach(e => {
  if (e.isIntersecting) e.target.classList.add('visible');
}), { threshold: 0.12 });
document.querySelectorAll('.reveal').forEach(el => io.observe(el));

// Copy buttons
document.querySelectorAll('[data-copy]').forEach(btn => {
  btn.addEventListener('click', async () => {
    const txt = btn.getAttribute('data-copy');
    try { await navigator.clipboard.writeText(txt); } catch {
      const ta = document.createElement('textarea');
      ta.value = txt; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    const old = btn.textContent; btn.textContent = 'Copied ✓';
    setTimeout(() => btn.textContent = old, 1400);
  });
});

// Eligibility checker
const verdict = $('#verdict'), vTitle = $('#verdictTitle'),
      vBody = $('#verdictBody'), vCta = $('#verdictCta');
$('#checkBtn').addEventListener('click', () => {
  const name = $('#cName').value.trim() || 'Your corporation';
  const cap = parseFloat($('#cCap').value);
  const margin = parseFloat($('#cMargin').value);
  const active = $('#cActive').checked, coord = $('#cCoord').checked;

  const fails = [];
  if (isNaN(cap)) fails.push('Enter your market cap ($M).');
  else if (cap < 350) fails.push(`Market cap $${cap}M is below the $350M floor.`);
  if (isNaN(margin)) fails.push('Enter your net margin %.');
  else if (margin < 10) fails.push(`Margin ${margin}% is below the 10% minimum (15% preferred).`);
  if (!active) fails.push('Daily-active status not confirmed.');
  if (!coord) fails.push('Coordination commitment not confirmed.');

  verdict.classList.remove('pass', 'fail');
  if (fails.length === 0) {
    verdict.classList.add('pass');
    vTitle.textContent = '✓ ELIGIBLE — open negotiations';
    vBody.innerHTML = `<strong>${escapeHtml(name)}</strong> passes: $${cap}M cap, ${margin}% margin, active + coordinated. Message <code>hyawii2.0</code> on Discord or mail <code>Larry Fink</code> in-game now.`;
    vCta.style.display = 'inline-flex';
  } else {
    verdict.classList.add('fail');
    vTitle.textContent = '✕ NOT ELIGIBLE YET';
    vBody.innerHTML = `<strong>${escapeHtml(name)}:</strong><br>• ` + fails.map(escapeHtml).join('<br>• ');
    vCta.style.display = 'none';
  }
  verdict.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
});
function escapeHtml(s){ return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

// Mail generator
$('#genMail').addEventListener('click', () => {
  const corp = $('#mCorp').value.trim() || '[Your Corp Name]';
  const cap = $('#mCap').value || '[350+]';
  const marg = $('#mMargin').value || '[10-15+]';
  const text =
`Subject: Vanguard Group — Entry Negotiation Request (${corp})

Hello Larry Fink,

I am writing on behalf of ${corp} to request entry negotiations for the Vanguard Group.

— Market Cap: $${cap}M (verified screenshot attached)
— Net Margin: ${marg}% sustained
— Activity: Daily-active leadership, responsive comms
— Commitment: Willing to coordinate pricing, supply, votes and crisis response with the group and its members.

Current members noted: BlackRock Incorporated, John Deere.

Please advise on verification steps and negotiation time.

Regards,
[Your Name] — ${corp} (A House Divided)`;
  $('#mailOut').value = text;
});
$('#copyMail').addEventListener('click', async () => {
  const ta = $('#mailOut');
  if (!ta.value) return;
  try { await navigator.clipboard.writeText(ta.value); } catch { ta.select(); document.execCommand('copy'); }
  const b = $('#copyMail'); const o = b.textContent; b.textContent = 'Copied ✓';
  setTimeout(() => b.textContent = o, 1400);
});

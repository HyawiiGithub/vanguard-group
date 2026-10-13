// Vanguard Group — live snapshot rendering + self-check. No API keys in this file.
const $ = (s) => document.querySelector(s);
$("#year").textContent = new Date().getFullYear();

const fmtMoney = (n) =>
  n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US");
const fmtPct = (n) => (n == null ? "—" : n.toFixed(2) + "%");
const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let SNAP = null;

async function load() {
  try {
    const r = await fetch("data/live.json", { cache: "no-store" });
    if (!r.ok) throw new Error("HTTP " + r.status);
    SNAP = await r.json();
    renderSnap(SNAP);
  } catch (e) {
    $("#snapTag").textContent = "SNAPSHOT UNAVAILABLE";
    $("#snapTag").classList.add("bad");
    $("#snapLine").textContent = "Could not load data/live.json (" + e.message + "). Figures below are stale — see repo.";
    $("#registerBody").innerHTML = '<tr><td colspan="8">Snapshot failed to load. Open data/live.json directly.</td></tr>';
    $("#dateline").textContent = "Snapshot unavailable.";
  }
}

function renderSnap(s) {
  const upd = new Date(s.updatedAt);
  $("#dateline").textContent =
    `Turn ${s.game.currentTurn} · ${s.game.gameDateLabel} · game ${s.game.status} · snapshot ${upd.toUTCString()}`;
  $("#snapTag").textContent = "VERIFIED " + upd.toISOString().slice(0, 10);
  $("#snapTag").classList.add("ok");
  $("#snapLine").textContent =
    `Source: ${s.source}. Next turn ${s.game.nextTurnAt || "—"}. ` +
    `Floor T-1 $${s.thresholds.marketCapFloor.toLocaleString("en-US")}, T-2 ${s.thresholds.marginFloorPct}%.`;

  $("#registerBody").innerHTML = s.corporations.map((c) => {
    const pass = c.checks.marketCapPass && c.checks.marginPass;
    const g = c.growth ? `${c.growth.pct >= 0 ? "+" : ""}${c.growth.pct.toFixed(2)}% (t${c.growth.fromTurn}→t${c.growth.toTurn})` : "n/a — new listing";
    return `<tr>
      <td><div class="corp-cell">
        <img src="${esc(c.logoUrl)}" alt="" loading="lazy" onerror="this.remove()" />
        <div><div class="cn"><a href="${esc(c.corpUrl)}">${esc(c.name)}</a></div>
        <div class="cid">#${c.id} · ${esc(c.type)} · ${esc(c.countryId)} · ${c.sectorCount} sectors · ${esc(c.creditRating || "")}</div></div>
      </div></td>
      <td>${esc(c.ceo || "—")}</td>
      <td class="num">${fmtMoney(c.revenue)}</td>
      <td class="num">${fmtMoney(c.operatingIncome)}</td>
      <td class="num">${fmtPct(c.marginPct)}</td>
      <td class="num">${fmtMoney(c.marketCap)}</td>
      <td class="num">${esc(g)}</td>
      <td><span class="stamp ${pass ? "pass" : "fail"}">${pass ? "PASS" : "FAIL T-1"}</span></td>
    </tr>`;
  }).join("");
}

// ---- self-check (T-1/T-2 + T-3), margin computed if revenue+income given
function readNum(id) {
  const v = $(id).value.trim().replace(/[$,%\s]/g, "");
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
}
function verdictBox(ok, title, bodyHtml) {
  const v = $("#verdict");
  v.classList.remove("pass", "fail");
  v.classList.add(ok ? "pass" : "fail");
  $("#verdictTitle").textContent = title;
  $("#verdictBody").innerHTML = bodyHtml;
}
$("#checkBtn").addEventListener("click", () => {
  const name = $("#cName").value.trim() || "Your corporation";
  const cap = readNum("#cCap"), rev = readNum("#cRev"), inc = readNum("#cInc");
  const active = $("#cActive").checked, coord = $("#cCoord").checked;
  const fails = [];
  if (cap == null || isNaN(cap)) fails.push("Market cap missing — enter the figure from your corporation page.");
  else if (cap < 350_000_000) fails.push(`Market cap ${fmtMoney(cap)} is below the $350,000,000 floor (T-1).`);
  let mg = null;
  if (rev != null && inc != null && !isNaN(rev) && !isNaN(inc) && rev > 0) mg = (inc / rev) * 100;
  if (mg == null) fails.push("Margin cannot be computed — enter revenue and operating income.");
  else if (mg < 10) fails.push(`Margin ${mg.toFixed(2)}% is below the 10% minimum (T-2).`);
  if (!active) fails.push("T-3: daily-active status not confirmed.");
  if (!coord) fails.push("T-3: coordination commitment not confirmed.");
  if (!fails.length) {
    verdictBox(true, "Passes self-check — file the dossier.",
      `<strong>${esc(name)}</strong>: ${fmtMoney(cap)} cap` +
      (mg != null ? `, ${mg.toFixed(2)}% margin` : "") +
      `, active and coordinated. Final verification is run by the group through the game API before negotiation. File via §4.`);
  } else {
    verdictBox(false, "Does not pass.", `<strong>${esc(name)}</strong>:<br>— ` + fails.map(esc).join("<br>— "));
  }
});
$("#lookupBtn").addEventListener("click", () => {
  const id = $("#cId").value.trim();
  if (!SNAP || !id) { verdictBox(false, "No lookup.", "Load the snapshot and enter a corp sequential ID first."); return; }
  const c = SNAP.corporations.find((x) => String(x.id) === String(id));
  if (!c) { verdictBox(false, "Not in snapshot.", `Corp #${esc(id)} is not one of the tracked members. Enter figures manually for a self-check.`); return; }
  $("#cName").value = c.name;
  $("#cCap").value = c.marketCap;
  $("#cRev").value = c.revenue;
  $("#cInc").value = c.operatingIncome;
  verdictBox(c.checks.marketCapPass && c.checks.marginPass, c.name + " (snapshot)",
    `Revenue ${fmtMoney(c.revenue)} · income ${fmtMoney(c.operatingIncome)} · margin ${fmtPct(c.marginPct)} · cap ${fmtMoney(c.marketCap)} · ` +
    (c.growth ? `growth ${c.growth.pct >= 0 ? "+" : ""}${c.growth.pct.toFixed(2)}% (t${c.growth.fromTurn}→t${c.growth.toTurn})` : "growth n/a") +
    `. <a href="${esc(c.corpUrl)}">Open corp page</a>.`);
});

// ---- copy buttons
document.querySelectorAll("[data-copy]").forEach((b) =>
  b.addEventListener("click", async () => {
    const t = b.getAttribute("data-copy");
    try { await navigator.clipboard.writeText(t); }
    catch { const ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove(); }
    const o = b.textContent; b.textContent = "Copied"; setTimeout(() => (b.textContent = o), 1200);
  })
);

// ---- dossier generator
$("#genMail").addEventListener("click", () => {
  const corp = $("#mCorp").value.trim() || "[Corporation]";
  const id = $("#mId").value.trim() || "[ID]";
  const cap = $("#mCap").value.trim() || "[market cap]";
  const mg = $("#mMargin").value.trim() || "[margin]";
  $("#mailOut").value =
`VANGUARD GROUP — ENTRY DOSSIER
Corporation: ${corp} (#${id})
Market cap: ${cap} (screenshot attached)
Margin: ${mg}% sustained (revenue + operating income attached)
Activity: daily-active leadership, responsive comms
Commitment: willing to coordinate pricing, supply, votes and crisis response with the group and all members.
Contact: [your Discord] / [your character name]
Sent to: hyawii2.0 (Discord) / Larry Fink (in-game mail)`;
});
$("#copyMail").addEventListener("click", async () => {
  const ta = $("#mailOut");
  if (!ta.value) return;
  try { await navigator.clipboard.writeText(ta.value); }
  catch { ta.select(); document.execCommand("copy"); }
  const b = $("#copyMail"), o = b.textContent; b.textContent = "Copied"; setTimeout(() => (b.textContent = o), 1200);
});

load();

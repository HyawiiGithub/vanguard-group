#!/usr/bin/env node
// Fetch live AHD corp data -> data/live.json
// Usage: AHD_API_KEY=ahd_pub_... node tools/fetch-ahd.mjs
// Never commit keys. In CI, key comes from repo secret AHD_API_KEY.
import { writeFile, mkdir, readFile } from "node:fs/promises";

const BASE = "https://ahousedividedgame.com";
const KEY = process.env.AHD_API_KEY;
if (!KEY) {
  console.error("Missing AHD_API_KEY env var.");
  process.exit(1);
}
const H = { "X-API-Key": KEY };
const j = async (p) => {
  const r = await fetch(BASE + p, { headers: H });
  if (!r.ok) throw new Error(`${p} -> ${r.status} ${await r.text()}`);
  return r.json();
};
const num = (n) => (typeof n === "number" && isFinite(n) ? n : null);
const marginPct = (f) =>
  f && num(f.totalRevenue) ? (num(f.operatingIncome) / f.totalRevenue) * 100 : null;

// growth: split-adjusted tape change over the trailing 30 turns, labeled.
// Splits parsed from tape notes; each trade scaled by splits newer than it.
// (The in-game 6M column uses internal per-turn snapshots we cannot fetch;
// BlackRock's +14k% there spans its listing run-up. Ours is trailing momentum.)
function growthFromTape(entries, lookback = 30) {
  if (!entries?.length) return null;
  const trades = entries
    .filter((e) => num(e.pricePerShareAnchor) && e.pricePerShareAnchor > 0)
    .sort((a, b) => a.turn - b.turn || new Date(a.createdAt) - new Date(b.createdAt));
  if (trades.length < 2) return null;
  const splits = entries
    .filter((e) => e.kind === "stock_split" || e.kind === "reverse_split")
    .map((e) => {
      const m = /([\d,]+)\s*[^0-9A-Za-z]+([\d,]+)\s*shares/.exec(e.note || "");
      if (!m) return null;
      return { turn: e.turn, ratio: Number(m[1].replace(/,/g, "")) / Number(m[2].replace(/,/g, "")) };
    })
    .filter(Boolean);
  const adj = (t) =>
    t.pricePerShareAnchor *
    splits.filter((s) => s.turn > t.turn).reduce((f, s) => f * s.ratio, 1);
  const first = trades[0], last = trades[trades.length - 1];
  if (last.turn - first.turn < 1) return null; // single-turn tape (founding transfers)
  const w = trades.filter((t) => t.turn >= last.turn - lookback);
  if (w.length < 2 || w[w.length - 1].turn - w[0].turn < 1) return null;
  const f = w[0], l = w[w.length - 1];
  const a0 = adj(f), a1 = adj(l);
  if (!(a0 > 0)) return null;
  return {
    pct: ((a1 - a0) / a0) * 100,
    fromTurn: f.turn,
    toTurn: l.turn,
    fromPrice: Math.round(a0 * 10000) / 10000,
    toPrice: Math.round(a1 * 10000) / 10000,
    trades: w.length,
    splitAdjusted: splits.length > 0,
    window: "30T",
  };
}

async function fullTape(id) {
  let entries = [];
  for (let pg = 1; pg <= 12; pg++) {
    const r = await j(`/api/public/v1/corporation/shares/history?id=${id}&pageSize=100&page=${pg}`);
    entries = entries.concat(r.entries || []);
    if (pg >= (r.pageCount || 1)) break;
  }
  return entries;
}

// split-adjusted [turn, price] series for charts (anchor units, current-share basis).
function tapeSeries(entries) {
  const splits = (entries || [])
    .filter((e) => e.kind === "stock_split" || e.kind === "reverse_split")
    .map((e) => {
      const m = /([\d,]+)\s*[^0-9A-Za-z]+([\d,]+)\s*shares/.exec(e.note || "");
      if (!m) return null;
      return { turn: e.turn, ratio: Number(m[1].replace(/,/g, "")) / Number(m[2].replace(/,/g, "")) };
    })
    .filter(Boolean);
  return (entries || [])
    .filter((e) => num(e.pricePerShareAnchor) && e.pricePerShareAnchor > 0)
    .sort((a, b) => a.turn - b.turn)
    .map((t) => [
      t.turn,
      Math.round(t.pricePerShareAnchor * splits.filter((s) => s.turn > t.turn).reduce((f, s) => f * s.ratio, 1) * 10000) / 10000,
    ]);
}

const FLOOR_MKT_USD = 350_000_000;
const FLOOR_MARGIN = 10;
// Vanguard alliance roster, tracked by sequentialId + expected identity.
//
// IMPORTANT: the engine REUSES a sequentialId once the corporation document is deleted.
// BlackRock (#498), Vermont Logistics (#964), John Deere (#853) and 簡素 (#521) all
// dissolved, and #853 was then handed to an unrelated newcomer ("Exxon Mobil").
// Tracking on the id alone would silently relabel that stranger as John Deere, so every
// fetch re-checks the identity and quarantines the row if it no longer matches.
const ROSTER = [
  { id: 498, name: "BlackRock Incorporated" },
  // #853 was renamed John Deere -> Exxon Mobil in-game (same corporation document,
  // same CEO, same logo document key). `formerly` is pinned here so the rename stays
  // visible forever, not just on the run that happens to detect it.
  { id: 853, name: "Exxon Mobil", formerly: "John Deere" },
  { id: 964, name: "Vermont Logistics" },
  { id: 496, name: "Pfizer" },
  { id: 645, name: "American Broadcasting Company" },
  { id: 767, name: "Ranco Weapon Manfacturing" },
  { id: 521, name: "簡素" },
  { id: 1084, name: "The Organization" },
  { id: 561, name: "I Love Misa" },
  { id: 565, name: "I Love Napoleon" },
  { id: 1341, name: "Vermont Retail" },
  { id: 1530, name: "Tinky Winky" },
];
const TRACKED = ROSTER.map((r) => r.id);
const rosterById = new Map(ROSTER.map((r) => [r.id, r]));

// Compare on a canonical form so cosmetic differences ("Foo Inc." vs "Foo Incorporated")
// don't trip the guard, while a genuinely different company does.
const SUFFIX = /\b(incorporated|inc|corp|corporation|company|co|ltd|limited|plc|holdings?|group|the)\b/g;
const normName = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, "")
    .replace(SUFFIX, "")
    .replace(/(incorporated|inc|corp|corporation|company|co|ltd|limited|plc|holdings?|group)/g, "");
const sameIdentity = (a, b) => normName(a) === normName(b);

// The engine reuses a sequentialId once a corporation document is deleted, so a name
// mismatch alone is ambiguous: it can mean our member was renamed, OR that our member
// dissolved and a stranger inherited the id. Distinguish them with the stable document
// key embedded in the corporation's logo asset name
// (".../corporation-logos/<docKey>-<epochMs>.webp"). Same docKey => same corporation,
// renamed. Different docKey => a different company squatting on a recycled id.
const docKey = (logoUrl) => {
  const m = /\/([0-9a-f]{16,})-(?:\d{10,})\.[a-z0-9]+$/i.exec(String(logoUrl || ""));
  return m ? m[1] : null;
};

const game = await j("/api/public/v1/game");
const forex = await j("/api/public/v1/forex");
const rates = {};
for (const c of forex.currencies || []) rates[c.currencyCode] = c.rate;
const countryCcy = {};
for (const c of forex.currencies || []) countryCcy[c.countryId] = c.currencyCode;
const toUSD = (v, ccy) =>
  v == null || !rates[ccy] || !rates["USD"] ? null : (v / rates[ccy]) * rates["USD"];
// financials (revenue/income/costs) are gross per game day (24 turns) in ANCHOR
// units (verified: 729,147,095 anchor displayed in-game as $687M).
// balanceSheet (market cap/cash/debt) is in HOME-CURRENCY units.
const anchorToUSD = (v) => (v == null || !rates["USD"] ? null : v * rates["USD"]);
const perUsd = (ccy) => (rates[ccy] && rates["USD"] ? rates[ccy] / rates["USD"] : null);

function corpRow(c, tape) {
  const ccy = countryCcy[c.countryId] || "USD";
  const rev = num(c.financials?.totalRevenue);
  const inc = num(c.financials?.operatingIncome);
  const mkt = num(c.balanceSheet?.marketCapitalization);
  const cash = num(c.balanceSheet?.cashOnHand);
  const debt = num(c.balanceSheet?.totalDebt);
  const mg = marginPct(c.financials);
  const g = growthFromTape(tape.entries);
  const mktUsd = toUSD(mkt, ccy);
  // The engine exposes NO `bankrupt` flag: insolvency is modelled as bond default +
  // negative liquid capital, and terminal bankruptcy is a hard delete (corp 404s).
  // So live distress must be inferred from what the public payload actually carries.
  const defaultedBonds = (c.bonds || []).filter((b) => b && b.defaulted);
  const distress = [];
  if (defaultedBonds.length) distress.push(`bond default (${defaultedBonds.length} bond${defaultedBonds.length > 1 ? "s" : ""})`);
  if (cash != null && cash < 0) distress.push("negative liquid capital");
  return {
    id: c.sequentialId,
    alive: true,
    dissolved: false,
    name: c.name,
    memberName: c.name,
    formerly: rosterById.get(c.sequentialId)?.formerly ?? null,
    type: c.type,
    typeLabel: c.typeLabel ?? c.type,
    description: c.description ?? null,
    countryId: c.countryId,
    headquartersState: c.headquartersState ?? null,
    currency: ccy,
    fxPerUsd: perUsd(ccy) == null ? null : Math.round(perUsd(ccy) * 100) / 100,
    corpUrl: c.corpUrl,
    logoUrl: c.logoUrl,
    brandColor: c.brandColor,
    ceo: c.ceo?.name ?? null,
    revenue: rev,
    operatingIncome: inc,
    marketCap: mkt,
    revenueUsd: anchorToUSD(rev),
    operatingIncomeUsd: anchorToUSD(inc),
    marketCapUsd: mktUsd,
    marginPct: mg == null ? null : Math.round(mg * 100) / 100,
    sharePrice: c.shareStructure?.sharePrice ?? null,
    totalShares: c.shareStructure?.totalShares ?? null,
    holders: (c.shareStructure?.shareholders || []).map((h) => ({
      name: h.name,
      shares: h.shares ?? null,
      pct: Math.round(h.percentage * 100) / 100,
    })),
    blackrockStakePct: (() => {
      const h = (c.shareStructure?.shareholders || []).find((x) =>
        /blackrock/i.test(x.name || "")
      );
      return h ? Math.round(h.percentage * 100) / 100 : 0;
    })(),
    creditRating: c.creditRating?.rating ?? null,
    creditScore: num(c.creditRating?.compositeScore),
    cashOnHand: cash,
    totalDebt: debt,
    defaultedBonds: defaultedBonds.length,
    // live insolvency signals (see note above): surfaced as a warning before
    // the engine finishes the wind-down and 404s the corp.
    distress,
    distressed: distress.length > 0,
    sectorCount: Array.isArray(c.sectors) ? c.sectors.length : null,
    workers: Array.isArray(c.sectors) ? c.sectors.reduce((a, s) => a + (num(s.workers) || 0), 0) : null,
    divRate: num(c.financials?.dividendRate),
    growth: g ? { ...g, pct: Math.round(g.pct * 100) / 100 } : null,
    tape: tapeSeries(tape.entries),
    checks: {
      marketCapPass: mktUsd == null ? null : mktUsd >= FLOOR_MKT_USD,
      marginPass: mg == null ? null : mg >= FLOOR_MARGIN,
    },
  };
}

const corporations = [];
const renames = [];
let prev = null;
try {
  prev = JSON.parse(await readFile("data/live.json", "utf8"));
} catch {}
const prevById = new Map(((prev && prev.corporations) || []).map((c) => [c.id, c]));
const prevTurn = prev && prev.game ? prev.game.currentTurn : null;
for (const id of TRACKED) {
  const expected = rosterById.get(id);
  try {
    const c = await j(`/api/public/v1/corporation?id=${id}`);
    // NOTE: the engine hardcodes `found: true` on every successful lookup, so it is
    // never a "corp is gone" signal. A dissolved corporation simply stops resolving.
    if (!c || !c.name) throw new Error("corp gone (id " + id + ")");
    // Identity guard: this id may have been recycled onto an unrelated corporation
    // after our member dissolved. Never let that stranger inherit the member's slot.
    if (expected && !sameIdentity(c.name, expected.name)) {
      const prior = prevById.get(id);
      const priorKey = prior ? docKey(prior.logoUrl) : null;
      const nowKey = docKey(c.logoUrl);
      const sameDoc = priorKey != null && nowKey != null && priorKey === nowKey;
      if (sameDoc) {
        // Same corporation document: our member was renamed in-game.
        console.log("corp #" + id + " RENAMED: '" + (prior && prior.name) + "' -> '" + c.name + "' (same corporation document)");
        renames.push({ id, from: (prior && prior.name) || expected.name, to: c.name, turn: game.currentTurn });
      } else {
        throw Object.assign(new Error("id " + id + " now belongs to '" + c.name + "'"), { reusedBy: c });
      }
    }
    const entries = await fullTape(id);
    const row = corpRow(c, { entries });
    const prior = prevById.get(id);
    if (expected && prior && !sameIdentity(prior.name, expected.name)) {
      row.renamedFrom = prior.name;
      row.memberName = expected.name;
    }
    corporations.push(row);
  } catch (e) {
    // 404 here == the engine hard-deleted the corporation, which is what terminal
    // bankruptcy looks like from outside (bond default -> wind-down -> deleteOne).
    // Freeze last-known figures so the warning keeps its numbers, and record the
    // exact turn it was last confirmed alive.
    const p = prevById.get(id);
    const reason = String((e && e.message) || e);
    const reused = e && e.reusedBy ? e.reusedBy : null;
    const gone = !!reused || /\b404\b|not found|corp gone/i.test(reason);
    console.log(
      "corp #" + id + " unreachable (" + reason + ") — " +
      (reused
        ? "ID REUSED by '" + reused.name + "': member dissolved, quarantining the newcomer"
        : gone
          ? "DISSOLVED (bankrupt): freezing last-known"
          : "transient: freezing last-known")
    );
    if (p) {
      corporations.push({
        ...p,
        alive: false,
        dissolved: gone ? true : p.dissolved ?? false,
        // If our member's name also drifted vs the roster, that is a rename, not a new company.
        memberName: expected ? expected.name : p.memberName ?? p.name,
        lastSeenTurn: p.lastSeenTurn ?? prevTurn,
        checkedTurn: game.currentTurn,
        ...(reused ? { idReusedBy: { id, name: reused.name, type: reused.type ?? null } } : {}),
        tape: [],
      });
    } else {
      corporations.push({
        id, name: expected ? expected.name : "Unknown #" + id,
        memberName: expected ? expected.name : null,
        alive: false, dissolved: gone ? true : false,
        lastSeenTurn: null, checkedTurn: game.currentTurn,
        type: null, typeLabel: null, description: null, countryId: null,
        headquartersState: null, currency: "USD", fxPerUsd: 1, corpUrl: null, logoUrl: null,
        brandColor: null, ceo: null, revenue: null, operatingIncome: null, marketCap: null,
        revenueUsd: null, operatingIncomeUsd: null, marketCapUsd: null, marginPct: null,
        sharePrice: null, totalShares: null, holders: [], blackrockStakePct: 0,
        creditRating: null, creditScore: null, cashOnHand: null, totalDebt: null,
        defaultedBonds: 0, distress: [], distressed: false,
        sectorCount: null, workers: null, divRate: null, growth: null,
        ...(reused ? { idReusedBy: { id, name: reused.name, type: reused.type ?? null } } : {}),
        checks: { marketCapPass: false, marginPass: false }, tape: [],
      });
    }
  }
}

// ties between members: cross-ownership, shared backers, shared CEOs.
const ties = [];
const byName = new Map(corporations.map((c) => [c.name.toLowerCase(), c]));
for (const b of corporations) {
  for (const h of b.holders || []) {
    const a = byName.get((h.name || "").toLowerCase());
    if (a && a.id !== b.id && h.pct > 0)
      ties.push({ type: "owns", from: a.name, to: b.name, pct: h.pct });
  }
}
const NOISE = /index fund|^\?\?$/i;
for (let i = 0; i < corporations.length; i++) {
  for (let j = i + 1; j < corporations.length; j++) {
    const A = corporations[i], B = corporations[j];
    if (A.ceo && B.ceo && A.ceo === B.ceo)
      ties.push({ type: "ceo", who: A.ceo, a: A.name, b: B.name });
    const ha = new Map((A.holders || []).map((h) => [h.name, h.pct]));
    for (const h of B.holders || []) {
      if (ha.has(h.name) && !NOISE.test(h.name || "") && !byName.has((h.name || "").toLowerCase()))
        ties.push({ type: "backer", who: h.name, a: A.name, aPct: ha.get(h.name), b: B.name, bPct: h.pct });
    }
  }
}

let larry = null;
try {
  larry = await j("/api/public/v1/character?name=" + encodeURIComponent("Larry Fink"));
} catch {}

// full corporation directory for site search (cheap: one request).
const dir = await j("/api/public/v1/corporations");
const corpsIndex = (dir.corporations || []).map((c) => ({
  id: c.sequentialId,
  name: c.name,
  type: c.type,
  country: c.countryId,
}));

const NOW = new Date().toISOString();

const out = {
  updatedAt: NOW,
  source: "ahousedividedgame.com /api/public/v1",
  displayCurrency: "USD",
  game: {
    currentTurn: game.currentTurn,
    gameDateLabel: game.gameDateLabel,
    status: game.status,
    nextTurnAt: game.nextTurnAt,
  },
  thresholds: { marketCapFloorUsd: FLOOR_MKT_USD, marginFloorPct: FLOOR_MARGIN },
  methodology:
    "financials (revenue/income) are gross per game day (24 turns) in ANCHOR units, converted x USD anchor rate for display. balanceSheet (market cap/cash/debt) is in HOME-CURRENCY units, converted via live forex. marginPct = operatingIncome / totalRevenue * 100. growth = split-adjusted tape change over trailing 30 turns (game 6M uses internal snapshots; figures converge for steady traders). Threshold checks run on USD market cap. BANKRUPTCY: the engine exposes no bankruptcy flag - terminal insolvency is a hard delete of the corporation document, so a bankrupt corp simply stops resolving and is recorded here as alive:false + dissolved:true with its last-verified figures frozen and lastSeenTurn recorded. Corps still trading but approaching default are flagged distressed:true from bonds[].defaulted or negative cashOnHand. Dissolved corps are excluded from all alliance sums and charts until they reappear.",
  corporations,
  renames,
  ties,
  forex: {
    rates,
    perUsd: Object.fromEntries(
      Object.keys(rates).map((k) => [k, perUsd(k) == null ? null : Math.round(perUsd(k) * 10000) / 10000])
    ),
    countryCcy,
  },
  contact: {
    discord: (larry && larry.characters && larry.characters[0] && larry.characters[0].discordUsername) || "hyawii2.0",
    character: "Larry Fink",
    characterUrl: (larry && larry.characters && larry.characters[0] && larry.characters[0].profileUrl) || null,
    ceoOf: (larry && larry.characters && larry.characters[0] && larry.characters[0].ceoOf) || "BlackRock Incorporated",
  },
};

await mkdir("data", { recursive: true });
await writeFile("data/live.json", JSON.stringify(out, null, 2) + "\n");
console.log("Wrote data/live.json");
await writeFile(
  "data/corps.json",
  JSON.stringify({ updatedAt: NOW, count: corpsIndex.length, corps: corpsIndex }) + "\n"
);
console.log("Wrote data/corps.json (" + corpsIndex.length + " corps)");

// rolling history for alliance charts (cap ~3000 points ≈ 31 days at 15min).
let hist = { points: [] };
try {
  hist = JSON.parse(await readFile("data/history.json", "utf8"));
  if (!Array.isArray(hist.points)) hist.points = [];
} catch {}
const lastT = hist.points.length ? new Date(hist.points[hist.points.length - 1].t).getTime() : 0;
if (Date.now() - lastT > 20 * 60 * 1000) {
  hist.points.push({
    t: NOW,
    turn: game.currentTurn,
    corps: corporations.map((c) => ({
      id: c.id,
      m: !c.alive ? null : (c.marketCapUsd == null ? null : Math.round(c.marketCapUsd)),
      r: !c.alive ? null : (c.revenueUsd == null ? null : Math.round(c.revenueUsd)),
      mg: !c.alive ? null : c.marginPct,
    })),
  });
}
if (hist.points.length > 3000) hist.points = hist.points.slice(-3000);
await writeFile("data/history.json", JSON.stringify(hist) + "\n");
console.log("history points:", hist.points.length);
for (const c of corporations) {
  if (c.alive === false) {
    console.log(
      `${c.name} (#${c.id}) BANKRUPT/DISSOLVED — last seen turn ${c.lastSeenTurn ?? "?"} (frozen $${Math.round(c.marketCapUsd || 0).toLocaleString()})`
    );
    continue;
  }
  const warn = c.distressed ? "  *** DISTRESS: " + c.distress.join(" + ") + " ***" : "";
  console.log(
    `${c.name} (#${c.id}, ${c.currency}): mkt=${c.marketCap} -> $${Math.round(c.marketCapUsd).toLocaleString()} | rev=${c.revenue} -> $${Math.round(c.revenueUsd).toLocaleString()} | margin=${c.marginPct}% | cash=$${Math.round(c.cashOnHand || 0).toLocaleString()} | workers=${c.workers ?? "n/a"} | growth=${c.growth ? c.growth.pct + "%" : "n/a"} | pass=${c.checks.marketCapPass && c.checks.marginPass}${warn}`
  );
}

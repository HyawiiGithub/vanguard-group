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
const TRACKED = [498, 853, 964, 496, 645, 767, 521, 1084, 561, 565];

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
  const mg = marginPct(c.financials);
  const g = growthFromTape(tape.entries);
  const mktUsd = toUSD(mkt, ccy);
  return {
    id: c.sequentialId,
    name: c.name,
    type: c.type,
    countryId: c.countryId,
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
for (const id of TRACKED) {
  const c = await j(`/api/public/v1/corporation?id=${id}`);
  const entries = await fullTape(id);
  corporations.push(corpRow(c, { entries }));
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

const larry = await j("/api/public/v1/character?name=" + encodeURIComponent("Larry Fink"));

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
    "financials (revenue/income) are gross per game day (24 turns) in ANCHOR units, converted x USD anchor rate for display. balanceSheet (market cap/cash/debt) is in HOME-CURRENCY units, converted via live forex. marginPct = operatingIncome / totalRevenue * 100. growth = split-adjusted tape change over trailing 30 turns (game 6M uses internal snapshots; figures converge for steady traders). Threshold checks run on USD market cap.",
  corporations,
  ties,
  forex: {
    rates,
    perUsd: Object.fromEntries(
      Object.keys(rates).map((k) => [k, perUsd(k) == null ? null : Math.round(perUsd(k) * 10000) / 10000])
    ),
    countryCcy,
  },
  contact: {
    discord: larry.characters?.[0]?.discordUsername ?? "hyawii2.0",
    character: "Larry Fink",
    characterUrl: larry.characters?.[0]?.profileUrl ?? null,
    ceoOf: larry.characters?.[0]?.ceoOf ?? "BlackRock Incorporated",
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
      m: c.marketCapUsd == null ? null : Math.round(c.marketCapUsd),
      r: c.revenueUsd == null ? null : Math.round(c.revenueUsd),
      mg: c.marginPct,
    })),
  });
}
if (hist.points.length > 3000) hist.points = hist.points.slice(-3000);
await writeFile("data/history.json", JSON.stringify(hist) + "\n");
console.log("history points:", hist.points.length);
for (const c of corporations) {
  console.log(
    `${c.name} (#${c.id}, ${c.currency}): mkt=${c.marketCap} -> $${Math.round(c.marketCapUsd).toLocaleString()} | rev=${c.revenue} -> $${Math.round(c.revenueUsd).toLocaleString()} | margin=${c.marginPct}% | growth=${c.growth ? c.growth.pct + "%" : "n/a"} | pass=${c.checks.marketCapPass && c.checks.marginPass}`
  );
}

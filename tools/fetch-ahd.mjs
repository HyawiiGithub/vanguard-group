#!/usr/bin/env node
// Fetch live AHD corp data -> data/live.json
// Usage: AHD_API_KEY=ahd_pub_... node tools/fetch-ahd.mjs
// Never commit keys. In CI, key comes from repo secret AHD_API_KEY.
import { writeFile, mkdir } from "node:fs/promises";

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

// growth from share tape: earliest post-split price vs latest price.
// Requires a real window (span >= 2 turns), else null (e.g. founding transfers).
function growthFromTape(entries) {
  if (!entries?.length) return null;
  const trades = entries
    .filter((e) => num(e.pricePerShareAnchor) && e.pricePerShareAnchor > 0)
    .sort((a, b) => a.turn - b.turn || new Date(a.createdAt) - new Date(b.createdAt));
  if (trades.length < 2) return null;
  const lastSplitTurn = entries
    .filter((e) => e.kind === "stock_split" || e.kind === "reverse_split")
    .reduce((m, e) => Math.max(m, e.turn), -1);
  const post = trades.filter((t) => t.turn > lastSplitTurn);
  if (post.length < 2) return null;
  const first = post[0], last = post[post.length - 1];
  if (last.turn - first.turn < 2) return null;
  return {
    pct: ((last.pricePerShareAnchor - first.pricePerShareAnchor) / first.pricePerShareAnchor) * 100,
    fromTurn: first.turn,
    toTurn: last.turn,
    fromPrice: first.pricePerShareAnchor,
    toPrice: last.pricePerShareAnchor,
    trades: post.length,
  };
}

const FLOOR_MKT_USD = 350_000_000;
const FLOOR_MARGIN = 10;
const TRACKED = [498, 853, 964, 496];

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
    creditRating: c.creditRating?.rating ?? null,
    sectorCount: Array.isArray(c.sectors) ? c.sectors.length : null,
    growth: g ? { ...g, pct: Math.round(g.pct * 100) / 100 } : null,
    checks: {
      marketCapPass: mktUsd == null ? null : mktUsd >= FLOOR_MKT_USD,
      marginPass: mg == null ? null : mg >= FLOOR_MARGIN,
    },
  };
}

const corporations = [];
for (const id of TRACKED) {
  const c = await j(`/api/public/v1/corporation?id=${id}`);
  const tape = await j(`/api/public/v1/corporation/shares/history?id=${id}&pageSize=50`);
  corporations.push(corpRow(c, tape));
}

const larry = await j("/api/public/v1/character?name=" + encodeURIComponent("Larry Fink"));

const out = {
  updatedAt: new Date().toISOString(),
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
    "financials (revenue/income) are gross per game day (24 turns) in ANCHOR units, converted x USD anchor rate for display. balanceSheet (market cap/cash/debt) is in HOME-CURRENCY units, converted via live forex. marginPct = operatingIncome / totalRevenue * 100. growth = share-tape last vs first post-split price (anchor units), requires >=2 turn window. Threshold checks run on USD market cap.",
  corporations,
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
for (const c of corporations) {
  console.log(
    `${c.name} (#${c.id}, ${c.currency}): mkt=${c.marketCap} -> $${Math.round(c.marketCapUsd).toLocaleString()} | rev=${c.revenue} -> $${Math.round(c.revenueUsd).toLocaleString()} | margin=${c.marginPct}% | growth=${c.growth ? c.growth.pct + "%" : "n/a"} | pass=${c.checks.marketCapPass && c.checks.marginPass}`
  );
}

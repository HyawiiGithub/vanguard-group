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

// growth from share tape: earliest post-split price vs latest price
function growthFromTape(entries) {
  if (!entries?.length) return null;
  // exclude splits/issuance/reverse_split with price 0
  const trades = entries
    .filter((e) => num(e.pricePerShareAnchor) && e.pricePerShareAnchor > 0)
    .sort((a, b) => a.turn - b.turn || new Date(a.createdAt) - new Date(b.createdAt));
  if (trades.length < 2) return null;
  // drop pre-split outliers: if a stock_split exists, only use trades after last split
  const lastSplitTurn = entries
    .filter((e) => e.kind === "stock_split" || e.kind === "reverse_split")
    .reduce((m, e) => Math.max(m, e.turn), -1);
  const post = trades.filter((t) => t.turn > lastSplitTurn);
  if (post.length < 2) return null;
  const first = post[0], last = post[post.length - 1];
  return {
    pct: ((last.pricePerShareAnchor - first.pricePerShareAnchor) / first.pricePerShareAnchor) * 100,
    fromTurn: first.turn,
    toTurn: last.turn,
    fromPrice: first.pricePerShareAnchor,
    toPrice: last.pricePerShareAnchor,
    trades: post.length,
  };
}

const FLOOR_MKT = 350_000_000;
const FLOOR_MARGIN = 10;

const game = await j("/api/public/v1/game");
const blackrock = await j("/api/public/v1/corporation?id=498");
const deere = await j("/api/public/v1/corporation?id=853");
const larry = await j("/api/public/v1/character?name=" + encodeURIComponent("Larry Fink"));
const tapeB = await j("/api/public/v1/corporation/shares/history?id=498&pageSize=50");
const tapeJ = await j("/api/public/v1/corporation/shares/history?id=853&pageSize=50");

function corpRow(c, tape) {
  const mkt = num(c.balanceSheet?.marketCapitalization);
  const rev = num(c.financials?.totalRevenue);
  const inc = num(c.financials?.operatingIncome);
  const mg = marginPct(c.financials);
  const g = growthFromTape(tape.entries);
  return {
    id: c.sequentialId,
    name: c.name,
    type: c.type,
    countryId: c.countryId,
    corpUrl: c.corpUrl,
    logoUrl: c.logoUrl,
    brandColor: c.brandColor,
    ceo: c.ceo?.name ?? null,
    revenue: rev,
    operatingIncome: inc,
    marginPct: mg == null ? null : Math.round(mg * 100) / 100,
    marketCap: mkt,
    sharePrice: num(c.shareStructure?.totalShares) ? num(c.shareStructure && c.shareStructure.sharePrice) ?? null : null,
    sharePriceRaw: c.shareStructure?.sharePrice ?? null,
    totalShares: c.shareStructure?.totalShares ?? null,
    creditRating: c.creditRating?.rating ?? null,
    sectorCount: Array.isArray(c.sectors) ? c.sectors.length : null,
    growth: g ? { ...g, pct: Math.round(g.pct * 100) / 100 } : null,
    checks: {
      marketCapPass: mkt == null ? null : mkt >= FLOOR_MKT,
      marginPass: mg == null ? null : mg >= FLOOR_MARGIN,
    },
  };
}

const out = {
  updatedAt: new Date().toISOString(),
  source: "ahousedividedgame.com /api/public/v1",
  game: {
    currentTurn: game.currentTurn,
    gameDateLabel: game.gameDateLabel,
    status: game.status,
    nextTurnAt: game.nextTurnAt,
  },
  thresholds: { marketCapFloor: FLOOR_MKT, marginFloorPct: FLOOR_MARGIN },
  methodology:
    "marginPct = operatingIncome / totalRevenue * 100 from /corporation. marketCap from balanceSheet.marketCapitalization. growth = share-tape last vs first post-split pricePerShareAnchor (all trades, anchor units). Tape is paged (50 most recent); growth window noted in fromTurn/toTurn.",
  corporations: [
    corpRow(blackrock, tapeB),
    corpRow(deere, tapeJ),
  ],
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
console.log(JSON.stringify(out, null, 2));

#!/usr/bin/env node
// Fetch Umbrella-registered corporation intelligence -> data/umbrella.json
// Usage: AHD_API_KEY=ahd_pub_... node tools/fetch-umbrella.mjs
//
// NOTE ON THE BANNER: the public v1 corporation payload does NOT expose the
// corporation's `headerImageUrl` hero banner (that field only comes from the
// cookie-authenticated in-game endpoint). It does expose `logoUrl` and
// `brandColor`, so the site renders the logo and builds a CSS banner from the
// brand colour instead of fetching a real banner image.
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

// Sector-type -> which threat axis it feeds. Grounded in the engine's own
// CorporationType union: `defense` is the military-weapons axis,
// `chemical_industries` + `healthcare` are the biochemical axis.
const THREAT_AXES = {
  military: ["defense"],
  biochemical: ["chemical_industries", "healthcare"],
};

const games = await j("/api/public/v1/game");
const forex = await j("/api/public/v1/forex");
const rates = {};
for (const c of forex.currencies || []) rates[c.currencyCode] = c.rate;
const countryCcy = {};
for (const c of forex.currencies || []) countryCcy[c.countryId] = c.currencyCode;
const toUSD = (v, ccy) =>
  v == null || !rates[ccy] || !rates["USD"] ? null : (v / rates[ccy]) * rates["USD"];

const dir = await j("/api/public/v1/corporations");
const matches = (dir.corporations || []).filter((c) => /umbrella/i.test(c.name || ""));
console.log("umbrella-registered corporations:", matches.length);

const corps = [];
for (const m of matches) {
  try {
    const c = await j(`/api/public/v1/corporation?id=${m.sequentialId}`);
    if (!c || !c.name) throw new Error("gone");
    const ccy = countryCcy[c.countryId] || "USD";
    const sectors = Array.isArray(c.sectors) ? c.sectors : [];

    const axis = {};
    for (const [name, types] of Object.entries(THREAT_AXES)) {
      const hit = sectors.filter((s) => types.includes(s.sectorType));
      axis[name] = {
        sectorTypes: types,
        sectorCount: hit.length,
        workers: hit.reduce((a, s) => a + (num(s.workers) || 0), 0),
        // sector revenue is in anchor units, same basis as financials.totalRevenue
        revenue: hit.reduce((a, s) => a + (num(s.revenue) || 0), 0),
        states: [...new Set(hit.map((s) => s.stateName).filter(Boolean))],
      };
    }

    const byType = {};
    for (const s of sectors) {
      const t = s.sectorType || "unknown";
      byType[t] = byType[t] || { sectorCount: 0, workers: 0, revenue: 0 };
      byType[t].sectorCount++;
      byType[t].workers += num(s.workers) || 0;
      byType[t].revenue += num(s.revenue) || 0;
    }

    corps.push({
      id: c.sequentialId,
      name: c.name,
      type: c.type,
      typeLabel: c.typeLabel ?? c.type,
      description: c.description ?? null,
      ceo: c.ceo?.name ?? null,
      ceoUrl: c.ceo?.profileUrl ?? null,
      corpUrl: c.corpUrl,
      logoUrl: c.logoUrl ?? null,
      bannerUrl: null, // not exposed by public v1
      brandColor: c.brandColor ?? null,
      countryId: c.countryId,
      headquartersState: c.headquartersState ?? null,
      currency: ccy,
      revenue: num(c.financials?.totalRevenue),
      revenueUsd: num(c.financials?.totalRevenue) == null ? null : num(c.financials.totalRevenue) * rates["USD"],
      operatingIncome: num(c.financials?.operatingIncome),
      marginPct: c.financials?.totalRevenue ? (num(c.financials.operatingIncome) / num(c.financials.totalRevenue)) * 100 : null,
      dividendRate: num(c.financials?.dividendRate),
      marketCap: num(c.balanceSheet?.marketCapitalization),
      marketCapUsd: toUSD(num(c.balanceSheet?.marketCapitalization), ccy),
      cashOnHand: toUSD(num(c.balanceSheet?.cashOnHand), ccy),
      totalDebt: toUSD(num(c.balanceSheet?.totalDebt), ccy),
      defaultedBonds: (c.bonds || []).filter((b) => b && b.defaulted).length,
      sharePrice: c.shareStructure?.sharePrice ?? null,
      totalShares: c.shareStructure?.totalShares ?? null,
      publicFloatPct: c.shareStructure?.publicFloatPct ?? null,
      creditRating: c.creditRating?.rating ?? null,
      creditScore: num(c.creditRating?.compositeScore),
      sectorCount: sectors.length,
      workers: sectors.reduce((a, s) => a + (num(s.workers) || 0), 0),
      sectorsByType: byType,
      threatAxes: axis,
      shareholders: (c.shareStructure?.shareholders || []).map((h) => ({
        name: h.name,
        shares: h.shares ?? null,
        pct: Math.round((h.percentage || 0) * 100) / 100,
      })),
      sectors: sectors.map((s) => ({
        sectorType: s.sectorType,
        stateName: s.stateName,
        revenue: num(s.revenue),
        profitMargin: num(s.profitMargin),
        workers: num(s.workers),
      })),
    });
    console.log(`  #${c.sequentialId} ${c.name}: ${sectors.length} sectors, ${axis.military.sectorCount} defense, ${axis.biochemical.sectorCount} chemical/healthcare`);
  } catch (e) {
    console.log(`  #${m.sequentialId} ${m.name}: unavailable (${e.message || e})`);
  }
}

// Roll the group up: parent + subsidiary, ownership already proven by the register.
const group = {
  count: corps.length,
  revenue: corps.reduce((a, c) => a + (c.revenue || 0), 0),
  revenueUsd: corps.reduce((a, c) => a + (c.revenueUsd || 0), 0),
  marketCapUsd: corps.reduce((a, c) => a + (c.marketCapUsd || 0), 0),
  cashUsd: corps.reduce((a, c) => a + (c.cashOnHand || 0), 0),
  debtUsd: corps.reduce((a, c) => a + (c.totalDebt || 0), 0),
  workers: corps.reduce((a, c) => a + (c.workers || 0), 0),
  sectorCount: corps.reduce((a, c) => a + (c.sectorCount || 0), 0),
  threatAxes: Object.keys(THREAT_AXES).reduce((acc, name) => {
    acc[name] = {
      sectorCount: corps.reduce((a, c) => a + c.threatAxes[name].sectorCount, 0),
      workers: corps.reduce((a, c) => a + c.threatAxes[name].workers, 0),
      revenue: corps.reduce((a, c) => a + c.threatAxes[name].revenue, 0),
    };
    return acc;
  }, {}),
};

const out = {
  updatedAt: new Date().toISOString(),
  game: { currentTurn: games.currentTurn, gameDateLabel: games.gameDateLabel },
  thread: {
    title: "Umbrella Corporation & Technologies",
    classification: "COUNTER-THREAT ASSESSMENT",
    threat: {
      primary: "Military Weapons Development",
      secondary: "Biochemical Weapons Development",
    },
    // Stated plainly: the engine has no tag called "umbrella". This group is
    // assembled by exact name match on the live corporation register.
    basis: "Exact name match /umbrella/i against the live AHD corporation register. The engine exposes no tag, category or 'umbrella' concept, so membership is established by registered name plus proven shareholding.",
    bannerNote: "Public API exposes logoUrl and brandColor only. The corporation hero banner (headerImageUrl) is not available from the public endpoint, so the site renders a brand-coloured banner.",
  },
  group,
  corporations: corps,
};

await mkdir("data", { recursive: true });
await writeFile("data/umbrella.json", JSON.stringify(out, null, 2) + "\n");
console.log("Wrote data/umbrella.json —", corps.length, "corporations;",
  group.workers.toLocaleString("en-US"), "workers;",
  "$" + Math.round(group.marketCapUsd).toLocaleString("en-US"), "market cap;",
  group.threatAxes.military.sectorCount, "defense sectors,",
  group.threatAxes.biochemical.sectorCount, "chemical/healthcare sectors");
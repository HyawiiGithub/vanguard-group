#!/usr/bin/env node
// Build full intelligence dossiers for every corporation listed in data/roster.json
// Usage: AHD_API_KEY=ahd_pub_... node tools/fetch-intel.mjs
//
// The roster file only says WHICH corporations to track and how to label them.
// Everything factual (CEO, logo, financials, share register, bonds, credit
// rating components, sector footprint, share tape) is filled in here from the
// live API, so nothing on the site is ever hand-entered.
//
// Writes data/intel.json.
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
  if (!r.ok) throw new Error(`${p} -> ${r.status}`);
  return r.json();
};
const num = (n) => (typeof n === "number" && isFinite(n) ? n : null);
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

// Sector type -> which threat axis the capability sits on.
const AXES = {
  biochemical: ["chemical_industries", "healthcare"],
  military: ["defense"],
};

let roster;
try {
  roster = JSON.parse(await readFile("data/roster.json", "utf8"));
} catch (e) {
  console.error("Could not read data/roster.json: " + (e.message || e));
  process.exit(1);
}

const game = await j("/api/public/v1/game");
const forex = await j("/api/public/v1/forex");
const rates = {};
for (const c of forex.currencies || []) rates[c.currencyCode] = c.rate;
const countryCcy = {};
for (const c of forex.currencies || []) countryCcy[c.countryId] = c.currencyCode;
const toUSD = (v, ccy) =>
  v == null || !rates[ccy] || !rates["USD"] ? null : (v / rates[ccy]) * rates["USD"];
const anchorUSD = (v) => (v == null || !rates["USD"] ? null : v * rates["USD"]);

// ---- resolve the roster: explicit entries + automatic name matches ----
const wanted = new Map();
for (const e of roster.entries || []) {
  const id = Number(e.id);
  if (!Number.isFinite(id)) continue;
  wanted.set(id, { id, threat: e.threat || null, member: !!e.member, alias: e.alias || null, note: e.note || null, source: "roster" });
}
const patterns = (roster.autoMatch || []).map((p) => new RegExp(p, "i"));
if (patterns.length) {
  const dir = await j("/api/public/v1/corporations");
  for (const c of dir.corporations || []) {
    if (patterns.some((p) => p.test(c.name || ""))) {
      if (!wanted.has(c.sequentialId)) {
        wanted.set(c.sequentialId, {
          id: c.sequentialId, threat: null, member: false, alias: null, note: null,
          source: "autoMatch",
        });
        console.log("  auto-matched: #" + c.sequentialId + " " + c.name);
      }
    }
  }
}
console.log("roster: " + wanted.size + " corporations");

// ---- per-corporation full fetch ----
async function shareTape(id) {
  const entries = [];
  for (let pg = 1; pg <= 12; pg++) {
    const r = await j(`/api/public/v1/corporation/shares/history?id=${id}&pageSize=100&page=${pg}`);
    entries.push(...(r.entries || []));
    if (pg >= (r.pageCount || 1)) break;
  }
  const splits = entries
    .filter((e) => e.kind === "stock_split" || e.kind === "reverse_split")
    .map((e) => {
      const m = /([\d,]+)\s*[^0-9A-Za-z]+([\d,]+)\s*shares/.exec(e.note || "");
      return m ? { turn: e.turn, ratio: Number(m[1].replace(/,/g, "")) / Number(m[2].replace(/,/g, "")) } : null;
    })
    .filter(Boolean);
  const trades = entries
    .filter((e) => num(e.pricePerShareAnchor) > 0)
    .sort((a, b) => a.turn - b.turn);
  const adj = (t) =>
    t.pricePerShareAnchor * splits.filter((s) => s.turn > t.turn).reduce((f, s) => f * s.ratio, 1);
  const series = trades.map((t) => [t.turn, Math.round(adj(t) * 10000) / 10000]);
  let growth = null;
  if (series.length >= 2) {
    const last = series[series.length - 1];
    const win = series.filter((p) => p[0] >= last[0] - 30);
    if (win.length >= 2 && win[win.length - 1][0] - win[0][0] >= 1 && win[0][1] > 0) {
      const a0 = win[0][1], a1 = win[win.length - 1][1];
      growth = {
        pct: Math.round(((a1 - a0) / a0) * 10000) / 100,
        fromTurn: win[0][0], toTurn: win[win.length - 1][0],
        fromPrice: Math.round(a0 * 10000) / 10000, toPrice: Math.round(a1 * 10000) / 10000,
        trades: win.length, splitAdjusted: splits.length > 0, window: "30T",
      };
    }
  }
  return { series, growth, tradeCount: trades.length, splitCount: splits.length };
}

async function tickerFor(id, name) {
  // the search endpoint exposes tickerSymbol, public v1 does not
  try {
    const r = await fetch(BASE + "/api/corporations/search?q=" + encodeURIComponent(name), { headers: H });
    if (!r.ok) return null;
    const j2 = await r.json();
    const hit = (j2.results || []).find((x) => Number(x.sequentialId) === id);
    return hit ? hit.ticker || null : null;
  } catch { return null; }
}

const corporations = [];
for (const [id, meta] of wanted) {
  try {
    const c = await j(`/api/public/v1/corporation?id=${id}`);
    if (!c || !c.name) throw new Error("not found (dissolved?)");
    const ccy = countryCcy[c.countryId] || "USD";
    const sectors = Array.isArray(c.sectors) ? c.sectors : [];
    const rev = num(c.financials?.totalRevenue);
    const inc = num(c.financials?.operatingIncome);
    const cost = num(c.financials?.operatingCosts);

    const axes = {};
    for (const [axis, types] of Object.entries(AXES)) {
      const hit = sectors.filter((s) => types.includes(s.sectorType));
      axes[axis] = {
        sectorTypes: types,
        sectorCount: hit.length,
        workers: hit.reduce((a, s) => a + (num(s.workers) || 0), 0),
        revenue: hit.reduce((a, s) => a + (num(s.revenue) || 0), 0),
        states: [...new Set(hit.map((s) => s.stateName).filter(Boolean))],
        sectorDetail: hit.map((s) => ({
          sectorType: s.sectorType, stateName: s.stateName,
          revenue: num(s.revenue), workers: num(s.workers),
        })),
      };
    }

    const byType = {};
    for (const s of sectors) {
      const t = s.sectorType || "unknown";
      byType[t] = byType[t] || { sectorCount: 0, workers: 0, revenue: 0, states: [], avgProfitMargin: 0, avgGrowth: 0, _m: 0, _g: 0 };
      byType[t].sectorCount++;
      byType[t].workers += num(s.workers) || 0;
      byType[t].revenue += num(s.revenue) || 0;
      if (s.stateName && !byType[t].states.includes(s.stateName)) byType[t].states.push(s.stateName);
      byType[t]._m += num(s.profitMargin) || 0;
      byType[t]._g += num(s.currentGrowthRate) || 0;
      byType[t]._mN = (byType[t]._mN || 0) + 1;
    }
    for (const t of Object.values(byType)) {
      t.avgProfitMargin = t._mN ? r2(t._m / t._mN) : null;
      t.avgGrowth = t._mN ? r2(t._g / t._mN) : null;
      delete t._m; delete t._g; delete t._mN;
    }

    const tape = await shareTape(id);
    const tk = await tickerFor(id, c.name);
    const bonds = (c.bonds || []).map((b) => ({
      id: b.id, couponRate: num(b.couponRate), maturityLabel: b.maturityLabel ?? null,
      totalIssued: num(b.totalIssued), marketPrice: num(b.marketPrice),
      turnsRemaining: num(b.turnsRemaining), yieldToMaturity: num(b.yieldToMaturity),
      holders: num(b.holders), defaulted: !!b.defaulted,
    }));

    corporations.push({
      // identity
      id: c.sequentialId, mongoId: c.id, name: c.name, displayName: meta.alias || c.name,
      alias: meta.alias || null, description: c.description ?? null,
      type: c.type, typeLabel: c.typeLabel ?? c.type,
      industryModel: c.industryModel ?? null, mediaDiscriminator: c.mediaDiscriminator ?? null,
      countryId: c.countryId, headquartersState: c.headquartersState ?? null,
      currency: ccy, ticker: tk, corpUrl: c.corpUrl, logoUrl: c.logoUrl ?? null,
      brandColor: c.brandColor ?? null, bannerUrl: null,
      ceo: { name: c.ceo?.name ?? null, profileUrl: c.ceo?.profileUrl ?? null },
      // roster metadata
      threat: meta.threat, member: meta.member, note: meta.note, source: meta.source,
      // financials (anchor units, per game day)
      financials: {
        totalRevenue: rev, operatingIncome: inc, operatingCosts: cost,
        dividendRate: num(c.financials?.dividendRate),
        revenueUsd: anchorUSD(rev), operatingIncomeUsd: anchorUSD(inc), operatingCostsUsd: anchorUSD(cost),
        marginPct: rev ? r2((inc / rev) * 100) : null,
      },
      // balance sheet (home currency)
      balanceSheet: {
        cashOnHand: num(c.balanceSheet?.cashOnHand),
        marketCapitalization: num(c.balanceSheet?.marketCapitalization),
        totalDebt: num(c.balanceSheet?.totalDebt),
        cashOnHandUsd: toUSD(num(c.balanceSheet?.cashOnHand), ccy),
        marketCapitalizationUsd: toUSD(num(c.balanceSheet?.marketCapitalization), ccy),
        totalDebtUsd: toUSD(num(c.balanceSheet?.totalDebt), ccy),
      },
      // equity
      shareStructure: {
        totalShares: num(c.shareStructure?.totalShares),
        publicFloat: num(c.shareStructure?.publicFloat),
        publicFloatPct: num(c.shareStructure?.publicFloatPct),
        sharePrice: num(c.shareStructure?.sharePrice),
        shareholders: (c.shareStructure?.shareholders || []).map((h) => ({
          name: h.name, shares: num(h.shares), pct: num(h.pct),
        })),
      },
      creditRating: {
        rating: c.creditRating?.rating ?? null,
        compositeScore: num(c.creditRating?.compositeScore),
        snapshotTurn: num(c.creditRating?.snapshotTurn),
        components: c.creditRating?.components ?? null,
      },
      bonds,
      defaultedBonds: bonds.filter((b) => b.defaulted).length,
      sectors: sectors.map((s) => ({
        stateId: s.stateId ?? null, stateName: s.stateName ?? null,
        sectorType: s.sectorType ?? null, revenue: num(s.revenue),
        profitMargin: num(s.profitMargin), currentGrowthRate: num(s.currentGrowthRate),
        workers: num(s.workers), mediaDiscriminator: s.mediaDiscriminator ?? null,
      })),
      sectorsByType: byType,
      sectorCount: sectors.length,
      workers: sectors.reduce((a, s) => a + (num(s.workers) || 0), 0),
      threatAxes: axes,
      growth: tape.growth,
      tape: tape.series,
      tapeTradeCount: tape.tradeCount,
      tapeSplitCount: tape.splitCount,
    });
    console.log(
      `  #${c.sequentialId} ${c.displayName || c.name}: ${sectors.length} sectors, ${bonds.length} bonds` +
      `, ${bonds.filter((b) => b.defaulted).length} defaulted, ${tape.tradeCount} tape trades` +
      `, ticker=${tk || "?"}`
    );
  } catch (e) {
    console.log(`  #${id}: unavailable (${e.message || e})`);
    corporations.push({
      id, displayName: meta.alias || "Unknown #" + id, name: null,
      threat: meta.threat, member: meta.member, note: meta.note, source: meta.source,
      alive: false, error: String(e.message || e),
    });
  }
}

const alive = corporations.filter((c) => c.alive !== false);
const sum = (f) => alive.reduce((a, c) => a + (f(c) || 0), 0);

const out = {
  updatedAt: new Date().toISOString(),
  game: { currentTurn: game.currentTurn, gameDateLabel: game.gameDateLabel, status: game.status, nextTurnAt: game.nextTurnAt },
  roster: {
    threats: roster.threats || [],
    autoMatch: roster.autoMatch || [],
    rosterFile: "data/roster.json",
    instructions: "Add a corporation by appending {\"id\": <sequentialId>, \"threat\": \"<classification>\"} to entries in data/roster.json. All facts are fetched automatically.",
  },
  threat: {
    default: "Biochemical Weapons Development",
    axes: AXES,
    note: "Threat labels are set in data/roster.json. The axis breakdown under each dossier is derived from real sector data, not asserted.",
  },
  totals: {
    corporations: alive.length,
    workers: sum((c) => c.workers),
    sectorCount: sum((c) => c.sectorCount),
    revenueUsd: sum((c) => c.financials?.revenueUsd),
    marketCapUsd: sum((c) => c.balanceSheet?.marketCapitalizationUsd),
    cashUsd: sum((c) => c.balanceSheet?.cashOnHandUsd),
    debtUsd: sum((c) => c.balanceSheet?.totalDebtUsd),
    bonds: sum((c) => (c.bonds || []).length),
    defaultedBonds: sum((c) => c.defaultedBonds),
    biochemicalSectors: sum((c) => c.threatAxes?.biochemical?.sectorCount),
    militarySectors: sum((c) => c.threatAxes?.military?.sectorCount),
  },
  corporations,
};

await mkdir("data", { recursive: true });
await writeFile("data/intel.json", JSON.stringify(out, null, 2) + "\n");
console.log(
  "Wrote data/intel.json —", out.totals.corporations, "corps,",
  out.totals.workers.toLocaleString("en-US"), "workers,",
  out.totals.bonds, "bonds,",
  out.totals.biochemicalSectors, "biochemical +",
  out.totals.militarySectors, "military sectors"
);

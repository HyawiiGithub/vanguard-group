/**
 * Vanguard AHD live-data Worker
 * ------------------------------------------------------------------
 * Fetches the A House Divided public API on a schedule / on demand,
 * caches the result in KV, and serves it with CORS so the static site
 * updates even when the operator's PC is offline.
 *
 * DEPLOY
 *   1. Create a KV namespace:  wrangler kv namespace create AH_DATA
 *   2. Put AHD_API_KEY as a SECRET (never in the source):
 *        wrangler secret put AHD_API_KEY
 *      or, in the Cloudflare dashboard: Settings > Variables > Secrets.
 *   3. Bind the namespace id in wrangler.toml (see BINDINGS below).
 *   4. Deploy:  npx wrangler deploy
 *
 * The GitHub Actions cron is NOT required while this is running; the Worker
 * has its own cron trigger plus stale-while-revalidate on every request.
 */

const BASE = "https://ahousedividedgame.com";
const FLOOR_MKT_USD = 350_000_000;
const FLOOR_MARGIN = 10;

// Tracked alliance members. Override with a comma-separated env var, e.g.
//   wrangler.toml -> [vars] ROSTER_IDS = "498,853,964"
const DEFAULT_ROSTER = [498, 853, 964, 496, 645, 767, 521, 1084, 561, 565, 1341, 1530];
// Intel dossiers (threat matrix). Override with INTEL_IDS.
const DEFAULT_INTEL = [824, 978];

// Expected name per id: the engine RECYCLES sequentialIds after a corporation
// dissolves, so a name mismatch means either a rename or a stranger squatting
// on the id. See tools/fetch-ahd.mjs for the full rationale.
const EXPECTED = {
  498: "BlackRock Incorporated",
  853: "Exxon Mobil",
  964: "Vermont Logistics",
  496: "Pfizer",
  645: "American Broadcasting Company",
  767: "Ranco Weapon Manfacturing",
  521: "簡素",
  1084: "The Organization",
  561: "I Love Misa",
  565: "I Love Napoleon",
  1341: "Vermont Retail",
  1530: "Tinky Winky",
};
const FORMERLY = { 853: "John Deere" };

const SUFFIX = /\b(incorporated|inc|corp|corporation|company|co|ltd|limited|plc|holdings?|group|the)\b/g;
const normName = (s) =>
  String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff]+/g, "")
    .replace(SUFFIX, "")
    .replace(/(incorporated|inc|corp|corporation|company|co|ltd|limited|plc|holdings?|group)/g, "");

const docKey = (logoUrl) => {
  const m = /\/([0-9a-f]{16,})-(?:\d{10,})\.[a-z0-9]+$/i.exec(String(logoUrl || ""));
  return m ? m[1] : null;
};

const num = (n) => (typeof n === "number" && isFinite(n) ? n : null);

// Accepts either a comma string (env var) or an array of numbers (defaults).
const parseIds = (list) =>
  (Array.isArray(list) ? list : String(list ?? "").split(","))
    .map((x) => (typeof x === "number" ? x : parseInt(String(x).trim(), 10)))
    .filter(Number.isFinite);
const r2 = (n) => (n == null ? null : Math.round(n * 100) / 100);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-AHD-Code",
  "Access-Control-Max-Age": "86400",
};

// The AHD API rate-limits and tells us how long to wait in the 429 body
// ({"retryAfterSeconds":4}). Honour it rather than guessing, otherwise every
// corporation in the roster lands in the "could not verify" state each cycle.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const j = async (path, key) => {
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch(BASE + path, { headers: { "X-API-Key": key } });
    if (r.ok) return r.json();
    let body = "";
    try { body = (await r.text()).slice(0, 200); } catch {}
    const retryable = r.status === 429 || r.status >= 500;
    if (retryable && attempt < 2) {
      let waitMs = 1200 * (attempt + 1);
      const m = /"retryAfterSeconds"\s*:\s*(\d+)/.exec(body);
      if (m) waitMs = Math.min(15000, (Number(m[1]) + 1) * 1000);
      await sleep(waitMs);
      continue;
    }
    throw new Error(`${path} -> ${r.status} ${body}`);
  }
};

// Cloudflare enforces a hard subrequest cap per invocation (50 on the free plan).
// A cold refresh of the full roster needs ~160 requests, which silently pushed every
// corporation into the "unreachable -> freeze last-known" branch and marked the whole
// alliance bankrupt. Everything below therefore runs against an explicit budget.
const SUBREQUEST_BUDGET = 44;
function makeBudget(limit = SUBREQUEST_BUDGET) {
  let left = limit;
  return {
    spend(n = 1) { left -= n; return left; },
    get left() { return left; },
    ok(min = 1) { return left >= min; },
  };
}

async function tapeFor(id, key, budget) {
  // Only the trailing 30 turns matter for growth, so fetch the FIRST page (to learn
  // pageCount) and then the NEWEST two pages rather than walking the whole tape.
  const base = `/api/public/v1/corporation/shares/history?id=${id}&pageSize=100&page=`;
  const first = await j(base + "1", key);
  budget && budget.spend(1);
  const entries = [...(first.entries || [])];
  const pageCount = first.pageCount || 1;
  for (let p = pageCount; p >= Math.max(1, pageCount - 1); p--) {
    if (p === 1) break;
    if (budget && !budget.ok(1)) break; // keep whatever we already have
    const r = await j(base + p, key);
    budget && budget.spend(1);
    entries.push(...(r.entries || []));
  }
  const splits = entries
    .filter((e) => e.kind === "stock_split" || e.kind === "reverse_split")
    .map((e) => {
      const m = /([\d,]+)\s*[^0-9A-Za-z]+([\d,]+)\s*shares/.exec(e.note || "");
      return m
        ? { turn: e.turn, ratio: Number(m[1].replace(/,/g, "")) / Number(m[2].replace(/,/g, "")) }
        : null;
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
        pct: r2(((a1 - a0) / a0) * 100),
        fromTurn: win[0][0],
        toTurn: win[win.length - 1][0],
        fromPrice: Math.round(a0 * 10000) / 10000,
        toPrice: Math.round(a1 * 10000) / 10000,
        trades: win.length,
        splitAdjusted: splits.length > 0,
        window: "30T",
      };
    }
  }
  return { series, growth, partial: budget ? !budget.ok(1) : false };
}

function rowsFromSectors(sectors) {
  const byType = {};
  for (const s of sectors) {
    const t = s.sectorType || "unknown";
    byType[t] = byType[t] || { sectorCount: 0, workers: 0, revenue: 0, states: [], avgProfitMargin: 0, avgGrowth: 0, _m: 0, _g: 0, _n: 0 };
    byType[t].sectorCount++;
    byType[t].workers += num(s.workers) || 0;
    byType[t].revenue += num(s.revenue) || 0;
    byType[t]._m += num(s.profitMargin) || 0;
    byType[t]._g += num(s.currentGrowthRate) || 0;
    byType[t]._n++;
    if (s.stateName && !byType[t].states.includes(s.stateName)) byType[t].states.push(s.stateName);
  }
  for (const t of Object.values(byType)) {
    t.avgProfitMargin = t._n ? r2(t._m / t._n) : null;
    t.avgGrowth = t._n ? r2(t._g / t._n) : null;
    delete t._m; delete t._g; delete t._n;
  }
  return byType;
}

const AXES = { biochemical: ["chemical_industries", "healthcare"], military: ["defense"] };
function axesFromSectors(sectors) {
  const out = {};
  for (const [axis, types] of Object.entries(AXES)) {
    const hit = sectors.filter((s) => types.includes(s.sectorType));
    out[axis] = {
      sectorTypes: types,
      sectorCount: hit.length,
      workers: hit.reduce((a, s) => a + (num(s.workers) || 0), 0),
      revenue: hit.reduce((a, s) => a + (num(s.revenue) || 0), 0),
      states: [...new Set(hit.map((s) => s.stateName).filter(Boolean))],
    };
  }
  return out;
}

/** Build one corporation record. Returns null when it no longer resolves. */
async function buildCorp(id, key, prev, ctx, budget) {
  const c = await j(`/api/public/v1/corporation?id=${id}`, key);
  if (!c || !c.name) return null;

  const expected = EXPECTED[id];
  let idReusedBy = null, renamedFrom = null;
  if (expected && normName(c.name) !== normName(expected)) {
    const priorKey = prev ? docKey(prev.logoUrl) : null;
    const nowKey = docKey(c.logoUrl);
    if (priorKey != null && nowKey != null && priorKey === nowKey) {
      renamedFrom = (prev && prev.name) || expected; // same document -> renamed
    } else {
      idReusedBy = { id, name: c.name, type: c.type || null }; // stranger on a recycled id
    }
  }

  const ccy = ctx.countryCcy[c.countryId] || "USD";
  const usdRate = ctx.rates["USD"];
  const toUSD = (v, c) => (v == null || !ctx.rates[c] || !usdRate ? null : (v / ctx.rates[c]) * usdRate);
  const anchorToUSD = (v) => (v == null || !usdRate ? null : v * usdRate);

  const tape = await tapeFor(id, key, budget);
  budget && budget.spend(1); // the corporation fetch itself
  const sectors = Array.isArray(c.sectors) ? c.sectors : [];
  const defaultedBonds = (c.bonds || []).filter((b) => b && b.defaulted);

  const rec = {
    id: c.sequentialId,
    alive: idReusedBy ? false : true,
    dissolved: false,
    name: c.name,
    memberName: expected || c.name,
    formerly: FORMERLY[id] || null,
    renamedFrom,
    type: c.type,
    typeLabel: c.typeLabel ?? c.type,
    description: c.description ?? null,
    countryId: c.countryId,
    headquartersState: c.headquartersState ?? null,
    currency: ccy,
    fxPerUsd: ctx.rates[ccy] && usdRate ? r2(ctx.rates[ccy] / usdRate) : null,
    corpUrl: c.corpUrl,
    logoUrl: c.logoUrl,
    brandColor: c.brandColor,
    bannerUrl: null, // not exposed by public v1
    ceo: c.ceo?.name ?? null,
    revenue: num(c.financials?.totalRevenue),
    operatingIncome: num(c.financials?.operatingIncome),
    operatingCosts: num(c.financials?.operatingCosts),
    marketCap: num(c.balanceSheet?.marketCapitalization),
    revenueUsd: anchorToUSD(num(c.financials?.totalRevenue)),
    operatingIncomeUsd: anchorToUSD(num(c.financials?.operatingIncome)),
    operatingCostsUsd: anchorToUSD(num(c.financials?.operatingCosts)),
    marketCapUsd: toUSD(num(c.balanceSheet?.marketCapitalization), ccy),
    cashOnHand: num(c.balanceSheet?.cashOnHand),
    cashOnHandUsd: toUSD(num(c.balanceSheet?.cashOnHand), ccy),
    totalDebt: num(c.balanceSheet?.totalDebt),
    totalDebtUsd: toUSD(num(c.balanceSheet?.totalDebt), ccy),
    marginPct: c.financials?.totalRevenue
      ? r2((num(c.financials.operatingIncome) / num(c.financials.totalRevenue)) * 100)
      : null,
    sharePrice: c.shareStructure?.sharePrice ?? null,
    totalShares: c.shareStructure?.totalShares ?? null,
    publicFloatPct: c.shareStructure?.publicFloatPct ?? null,
    holders: (c.shareStructure?.shareholders || []).map((h) => ({
      name: h.name,
      shares: h.shares ?? null,
      pct: r2(h.percentage),
    })),
    creditRating: c.creditRating?.rating ?? null,
    creditScore: num(c.creditRating?.compositeScore),
    creditComponents: c.creditRating?.components ?? null,
    defaultedBonds: defaultedBonds.length,
    bonds: (c.bonds || []).map((b) => ({
      couponRate: num(b.couponRate),
      maturityLabel: b.maturityLabel ?? null,
      totalIssued: num(b.totalIssued),
      marketPrice: num(b.marketPrice),
      turnsRemaining: num(b.turnsRemaining),
      yieldToMaturity: num(b.yieldToMaturity),
      holders: num(b.holders),
      defaulted: !!b.defaulted,
    })),
    distress: [
      ...(defaultedBonds.length ? [`bond default (${defaultedBonds.length})`] : []),
      ...(num(c.balanceSheet?.cashOnHand) < 0 ? ["negative liquid capital"] : []),
    ],
    distressed: defaultedBonds.length > 0 || num(c.balanceSheet?.cashOnHand) < 0,
    sectorCount: sectors.length,
    workers: sectors.reduce((a, s) => a + (num(s.workers) || 0), 0),
    divRate: num(c.financials?.dividendRate),
    sectorsByType: rowsFromSectors(sectors),
    growth: tape.growth,
    tape: tape.series,
    checkedTurn: ctx.game.currentTurn,
  };
  if (idReusedBy) rec.idReusedBy = idReusedBy;
  rec.checks = {
    marketCapPass: rec.marketCapUsd == null ? null : rec.marketCapUsd >= FLOOR_MKT_USD,
    marginPass: rec.marginPct == null ? null : rec.marginPct >= FLOOR_MARGIN,
  };
  return rec;
}

/** Full refresh. Returns every dataset the site consumes. */
async function refreshAll(env) {
  const key = env.AHD_API_KEY;
  if (!key) throw new Error("AHD_API_KEY secret is not set");
  const budget = makeBudget(parseInt(env.SUBREQUEST_BUDGET || "44", 10));
  const errors = [];

  const game = await j("/api/public/v1/game", key);
  budget.spend(1);
  const forex = await j("/api/public/v1/forex", key);
  budget.spend(1);
  const rates = {};
  const countryCcy = {};
  for (const c of forex.currencies || []) rates[c.currencyCode] = c.rate;
  for (const c of forex.currencies || []) countryCcy[c.countryId] = c.currencyCode;
  const ctx = { game, rates, countryCcy };

  let prev = null;
  try {
    prev = JSON.parse(await env.AH_DATA.get("live", "json"));
  } catch {}
  if (!prev || !prev.corporations) {
    // Cold cache: seed from the snapshot already published on GitHub Pages so the
    // FROZEN last-known figures of bankrupt corps are not silently lost to $0.
    // Without this, the first Worker run would blank out the insolvency register.
    prev = await loadPublished(env);
  }

  const rosterIds = parseIds(env.ROSTER_IDS || DEFAULT_ROSTER);
  const prevById = new Map(((prev && prev.corporations) || []).map((c) => [c.id, c]));

  // Per-corp cache so a refresh only spends subrequests on stale entries, and so a
  // budget shortfall degrades to "reuse last good" instead of "mark as bankrupt".
  const CORP_TTL = 10 * 60 * 1000;
  const cachedCorps = new Map();
  for (const id of rosterIds) {
    let c = null;
    try {
      const raw = JSON.parse(await env.AH_DATA.get("corp:" + id, "json"));
      if (raw && raw.__at && Date.now() - new Date(raw.__at).getTime() < CORP_TTL) {
        const { __at, ...rest } = raw;
        c = rest;
      }
    } catch {}
    if (c) cachedCorps.set(id, c);
  }

  const corporations = [];
  const renames = [];
  for (const id of rosterIds) {
    if (cachedCorps.has(id)) {
      const c = cachedCorps.get(id);
      corporations.push(c);
      if (c.renamedFrom) renames.push({ id, from: c.renamedFrom, to: c.name, turn: c.gameTurn || game.currentTurn });
      continue;
    }
    // Reserve enough headroom that a failed corp can still be recorded.
    if (!budget.ok(5)) {
      errors.push(`#${id} deferred: subrequest budget exhausted`);
      const p = prevById.get(id);
      if (p) corporations.push({ ...p, checkedTurn: game.currentTurn, deferred: true });
      continue;
    }
    try {
      const rec = await buildCorp(id, key, prevById.get(id), ctx, budget);
      if (rec) {
        rec.gameTurn = game.currentTurn;
        if (rec.renamedFrom) renames.push({ id, from: rec.renamedFrom, to: rec.name, turn: game.currentTurn });
        corporations.push(rec);
        await env.AH_DATA.put("corp:" + id, JSON.stringify({ __at: new Date().toISOString(), ...rec }));
      }
    } catch (e) {
      const msg = String(e.message || e);
      errors.push(`#${id}: ${msg}`);
      const p = prevById.get(id);
      const gone = /\b404\b|not found/i.test(msg);
      const frozen = p || {
        id,
        name: EXPECTED[id] || "Unknown #" + id,
        memberName: EXPECTED[id] || null,
        formerly: FORMERLY[id] || null,
        type: null, typeLabel: null, description: null, countryId: null,
        headquartersState: null, currency: "USD", fxPerUsd: 1, corpUrl: null,
        logoUrl: null, brandColor: null, bannerUrl: null, ceo: null,
        revenue: null, operatingIncome: null, operatingCosts: null, marketCap: null,
        revenueUsd: null, operatingIncomeUsd: null, operatingCostsUsd: null,
        marketCapUsd: null, cashOnHand: null, cashOnHandUsd: null,
        totalDebt: null, totalDebtUsd: null, marginPct: null,
        sharePrice: null, totalShares: null, publicFloatPct: null,
        holders: [], creditRating: null, creditScore: null, creditComponents: null,
        defaultedBonds: 0, bonds: [], distress: [], distressed: false,
        sectorCount: null, workers: null, divRate: null, sectorsByType: {}, growth: null,
      };
      // A 404 is a genuine dissolution. Anything else (429, 5xx, timeout) is a
      // transport failure and must NEVER be reported as bankruptcy: keep the last
      // known liveness and flag it stale so the site can say "could not verify"
      // instead of declaring the company bankrupt.
      const keepAlive = gone ? false : frozen.alive !== false;
      corporations.push({
        ...frozen,
        alive: keepAlive,
        dissolved: gone ? true : frozen.dissolved ?? false,
        stale: !gone,
        fetchError: gone ? null : msg.slice(0, 160),
        lastSeenTurn: frozen.lastSeenTurn ?? (prev && prev.game ? prev.game.currentTurn : null),
        checkedTurn: game.currentTurn,
        tape: [],
        checks: frozen.checks ?? { marketCapPass: false, marginPass: false },
      });
    }
  }

  // ties between members
  const ties = [];
  const byName = new Map(corporations.map((c) => [String(c.name).toLowerCase(), c]));
  for (const b of corporations) {
    for (const h of b.holders || []) {
      const a = byName.get(String(h.name || "").toLowerCase());
      if (a && a.id !== b.id && h.pct > 0) ties.push({ type: "owns", from: a.name, to: b.name, pct: h.pct });
    }
  }
  const NOISE = /index fund|^\?\?$/i;
  for (let i = 0; i < corporations.length; i++) {
    for (let j = i + 1; j < corporations.length; j++) {
      const A = corporations[i], B = corporations[j];
      if (A.ceo && B.ceo && A.ceo === B.ceo) ties.push({ type: "ceo", who: A.ceo, a: A.name, b: B.name });
      const ha = new Map((A.holders || []).map((h) => [h.name, h.pct]));
      for (const h of B.holders || []) {
        if (ha.has(h.name) && !NOISE.test(h.name || "") && !byName.has(String(h.name || "").toLowerCase()))
          ties.push({ type: "backer", who: h.name, a: A.name, aPct: ha.get(h.name), b: B.name, bPct: h.pct });
      }
    }
  }

  const live = {
    updatedAt: new Date().toISOString(),
    source: "cloudflare-worker /api/public/v1",
    displayCurrency: "USD",
    diagnostics: {
      subrequestsUsed: SUBREQUEST_BUDGET - budget.left,
      subrequestBudget: SUBREQUEST_BUDGET,
      deferred: errors.filter((e) => /deferred/.test(e)),
      errors,
    },
    game: {
      currentTurn: game.currentTurn,
      gameDateLabel: game.gameDateLabel,
      status: game.status,
      nextTurnAt: game.nextTurnAt,
    },
    thresholds: { marketCapFloorUsd: FLOOR_MKT_USD, marginFloorPct: FLOOR_MARGIN },
    corporations,
    renames,
    ties,
    forex: {
      rates,
      perUsd: Object.fromEntries(
        Object.keys(rates).map((k) => [
          k,
          rates[k] && rates["USD"] ? r2(rates[k] / rates["USD"]) : null,
        ])
      ),
      countryCcy,
    },
  };

  // rolling history
  let hist = { points: [] };
  try {
    hist = JSON.parse(await env.AH_DATA.get("history", "json")) || hist;
    if (!Array.isArray(hist.points)) hist.points = [];
  } catch {}
  const lastT = hist.points.length ? new Date(hist.points[hist.points.length - 1].t).getTime() : 0;
  if (Date.now() - lastT > 20 * 60 * 1000) {
    hist.points.push({
      t: new Date().toISOString(),
      turn: game.currentTurn,
      corps: corporations.map((c) => ({
        id: c.id,
        m: !c.alive ? null : c.marketCapUsd == null ? null : Math.round(c.marketCapUsd),
        r: !c.alive ? null : c.revenueUsd == null ? null : Math.round(c.revenueUsd),
        mg: !c.alive ? null : c.marginPct,
      })),
    });
  }
  if (hist.points.length > 3000) hist.points = hist.points.slice(-3000);

  // corporation directory - rebuilt occasionally, not on every refresh
  let corps = { count: 0, corps: [] };
  const corpsDiag = { fetched: false, reason: "" };
  const dirAt = await env.AH_DATA.get("corps_meta", "json").catch(() => null);
  const dirFresh = dirAt && Date.now() - new Date(dirAt.at || 0).getTime() < 6 * 60 * 60 * 1000;
  if (dirFresh) {
    try { corps = JSON.parse(await env.AH_DATA.get("corps", "json")) || corps; } catch {}
    corpsDiag.reason = "fresh (skipped fetch)";
  } else if (!budget.ok(1)) {
    // Previously this branch did not exist, so an exhausted budget silently left the
    // directory empty and the empty result got cached.
    corpsDiag.reason = "SKIPPED: subrequest budget exhausted";
    errors.push("corps.json " + corpsDiag.reason);
  } else {
    try {
      const res = await fetch(BASE + "/api/public/v1/corporations", { headers: { "X-API-Key": key } });
      budget.spend(1);
      const text = await res.text();
      corpsDiag.fetched = true;
      corpsDiag.status = res.status;
      corpsDiag.bytes = text.length;
      corpsDiag.head = text.slice(0, 160);
      if (!res.ok) throw new Error(`corps list -> ${res.status} ${text.slice(0, 120)}`);
      const dir = JSON.parse(text);
      if (!Array.isArray(dir.corporations)) throw new Error("corps list had no corporations array");
      corps = {
        updatedAt: new Date().toISOString(),
        count: dir.corporations.length,
        corps: dir.corporations.map((c) => ({
          id: c.sequentialId, name: c.name, type: c.type, country: c.countryId,
        })),
      };
      await env.AH_DATA.put("corps_meta", JSON.stringify({ at: new Date().toISOString() }));
    } catch (e) {
      errors.push("corps.json: " + String(e.message || e));
      try { corps = JSON.parse(await env.AH_DATA.get("corps", "json")) || corps; } catch {}
    }
  }

  // intel dossiers for the threat matrix
  const intelIds = parseIds(env.INTEL_IDS || DEFAULT_INTEL);
  let intel = { updatedAt: new Date().toISOString(), corporations: [], totals: {}, threat: {} };
  try {
    const threatFor = async (id) => (env["THREAT_" + id]) || "Biochemical Weapons Development";
    const list = [];
    for (const id of intelIds) {
      if (!budget.ok(2)) {
        errors.push(`intel #${id} deferred: subrequest budget exhausted`);
        try {
          const prior = JSON.parse(await env.AH_DATA.get("intel", "json"));
          const hit = ((prior && prior.corporations) || []).find((x) => x.id === id);
          if (hit) list.push(hit);
        } catch {}
        continue;
      }
      try {
        const c = await j(`/api/public/v1/corporation?id=${id}`, key);
        budget.spend(1);
        if (!c || !c.name) continue;
        const ccy = countryCcy[c.countryId] || "USD";
        const toUSD = (v) => (v == null || !rates[ccy] || !rates["USD"] ? null : (v / rates[ccy]) * rates["USD"]);
        const aUSD = (v) => (v == null || !rates["USD"] ? null : v * rates["USD"]);
        const sectors = Array.isArray(c.sectors) ? c.sectors : [];
        const rev = num(c.financials?.totalRevenue);
        const inc = num(c.financials?.operatingIncome);
        let ticker = null;
        try {
          const sr = await fetch(BASE + "/api/corporations/search?q=" + encodeURIComponent(c.name), {
            headers: { "X-API-Key": key },
          });
          budget.spend(1);
          if (sr.ok) {
            const hit = ((await sr.json()).results || []).find((x) => Number(x.sequentialId) === id);
            if (hit) ticker = hit.ticker || null;
          }
        } catch {}
        list.push({
          id: c.sequentialId,
          name: c.name,
          displayName: c.name,
          description: c.description ?? null,
          type: c.type,
          typeLabel: c.typeLabel ?? c.type,
          countryId: c.countryId,
          headquartersState: c.headquartersState ?? null,
          currency: ccy,
          ticker,
          corpUrl: c.corpUrl,
          logoUrl: c.logoUrl ?? null,
          brandColor: c.brandColor ?? null,
          bannerUrl: null,
          ceo: { name: c.ceo?.name ?? null, profileUrl: c.ceo?.profileUrl ?? null },
          threat: await threatFor(id),
          member: false,
          note: null,
          source: "worker",
          financials: {
            totalRevenue: rev,
            operatingIncome: inc,
            operatingCosts: num(c.financials?.operatingCosts),
            dividendRate: num(c.financials?.dividendRate),
            revenueUsd: aUSD(rev),
            operatingIncomeUsd: aUSD(inc),
            operatingCostsUsd: aUSD(num(c.financials?.operatingCosts)),
            marginPct: rev ? r2((inc / rev) * 100) : null,
          },
          balanceSheet: {
            cashOnHand: num(c.balanceSheet?.cashOnHand),
            marketCapitalization: num(c.balanceSheet?.marketCapitalization),
            totalDebt: num(c.balanceSheet?.totalDebt),
            cashOnHandUsd: toUSD(num(c.balanceSheet?.cashOnHand)),
            marketCapitalizationUsd: toUSD(num(c.balanceSheet?.marketCapitalization)),
            totalDebtUsd: toUSD(num(c.balanceSheet?.totalDebt)),
          },
          shareStructure: {
            totalShares: num(c.shareStructure?.totalShares),
            publicFloat: num(c.shareStructure?.publicFloat),
            publicFloatPct: num(c.shareStructure?.publicFloatPct),
            sharePrice: num(c.shareStructure?.sharePrice),
            shareholders: (c.shareStructure?.shareholders || []).map((h) => ({
              name: h.name, shares: num(h.shares), pct: r2(h.percentage),
            })),
          },
          creditRating: {
            rating: c.creditRating?.rating ?? null,
            compositeScore: num(c.creditRating?.compositeScore),
            snapshotTurn: num(c.creditRating?.snapshotTurn),
            components: c.creditRating?.components ?? null,
          },
          bonds: (c.bonds || []).map((b) => ({
            couponRate: num(b.couponRate),
            maturityLabel: b.maturityLabel ?? null,
            totalIssued: num(b.totalIssued),
            marketPrice: num(b.marketPrice),
            turnsRemaining: num(b.turnsRemaining),
            yieldToMaturity: num(b.yieldToMaturity),
            holders: num(b.holders),
            defaulted: !!b.defaulted,
          })),
          defaultedBonds: (c.bonds || []).filter((b) => b.defaulted).length,
          sectors: sectors.map((s) => ({
            stateId: s.stateId ?? null,
            stateName: s.stateName ?? null,
            sectorType: s.sectorType ?? null,
            revenue: num(s.revenue),
            profitMargin: num(s.profitMargin),
            currentGrowthRate: num(s.currentGrowthRate),
            workers: num(s.workers),
          })),
          sectorsByType: rowsFromSectors(sectors),
          sectorCount: sectors.length,
          workers: sectors.reduce((a, s) => a + (num(s.workers) || 0), 0),
          threatAxes: axesFromSectors(sectors),
          growth: null,
          tape: [],
          tapeTradeCount: 0,
          tapeSplitCount: 0,
        });
      } catch (e) {
        list.push({ id, displayName: "Unknown #" + id, alive: false, error: String(e.message || e) });
      }
    }
    const alive = list.filter((c) => c.alive !== false);
    const sum = (f) => alive.reduce((a, c) => a + (f(c) || 0), 0);
    intel = {
      updatedAt: new Date().toISOString(),
      game: { currentTurn: game.currentTurn, gameDateLabel: game.gameDateLabel },
      roster: { rosterFile: "data/roster.json" },
      threat: { default: "Biochemical Weapons Development", axes: AXES, note: "Labels from Worker config / data/roster.json; axes derived from real sector data." },
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
      corporations: list,
    };
  } catch {}

  return { live, hist, corps, intel, errors, corpsDiag, budgetUsed: SUBREQUEST_BUDGET - budget.left };
}

/**
 * Cold-start seed. Fetches the already-published snapshot once and caches it, so
 * dissolved corps keep their frozen figures instead of resetting to zero.
 * Disable with PUBLISHED_SNAPSHOT = "" if you would rather start clean.
 */
const PUBLISHED_DEFAULT = "https://hyawiigithub.github.io/vanguard-group/data/live.json";
async function loadPublished(env) {
  const url = env.PUBLISHED_SNAPSHOT === "" ? null : (env.PUBLISHED_SNAPSHOT || PUBLISHED_DEFAULT);
  if (!url) return null;
  try {
    let cachedSnap = null;
    try { cachedSnap = JSON.parse(await env.AH_DATA.get("published", "json")); } catch {}
    if (cachedSnap) return cachedSnap;
    const r = await fetch(url);
    if (!r.ok) return null;
    const j2 = await r.json();
    if (j2 && Array.isArray(j2.corporations)) {
      await env.AH_DATA.put("published", JSON.stringify(j2));
      return j2;
    }
  } catch {}
  return null;
}

/** Refresh + persist to KV. Serialised so a stampede of requests does one fetch. */
let inflight = null;
async function doRefresh(env, ttl) {
  if (inflight) return inflight;
  inflight = (async () => {
    const data = await refreshAll(env);
    // Never persist a degraded dataset. A 429/5xx storm once cached an EMPTY
    // corps.json and intel, and because those keys looked fresh the Worker then
    // served emptiness until the TTL expired. Keep the last known-good instead.
    const keepGood = async (key, next, isHealthy) => {
      if (isHealthy(next)) return next;
      const prev = await env.AH_DATA.get(key, "json").catch(() => null);
      if (prev && isHealthy(prev)) {
        data.degraded = data.degraded || [];
        data.degraded.push(key + ": refresh degraded, kept previous good copy");
        return prev;
      }
      return next;
    };
    data.corps = await keepGood("corps", data.corps, (v) => v && v.count > 0);
    data.intel = await keepGood("intel", data.intel, (v) => v && v.totals && v.totals.corporations > 0);
    data.live = await keepGood(
      "live",
      data.live,
      (v) => v && Array.isArray(v.corporations) && v.corporations.length > 0 &&
             v.corporations.filter((c) => c.alive !== false).length > 0
    );

    const meta = {
      at: new Date().toISOString(),
      turn: data.live.game.currentTurn,
      subrequestsUsed: data.budgetUsed,
      errors: (data.errors || []).slice(0, 12),
      degraded: data.degraded || [],
      corpsDiag: data.corpsDiag || null,
    };
    await Promise.all([
      env.AH_DATA.put("live", JSON.stringify(data.live)),
      env.AH_DATA.put("history", JSON.stringify(data.hist)),
      env.AH_DATA.put("corps", JSON.stringify(data.corps)),
      env.AH_DATA.put("intel", JSON.stringify(data.intel)),
      env.AH_DATA.put("meta", JSON.stringify(meta)),
    ]);
    return data;
  })();
  try {
    return await inflight;
  } finally {
    inflight = null;
  }
}

async function cached(name, env, ttl, fallbackKey) {
  const raw = await env.AH_DATA.get(name, "json");
  const meta = (await env.AH_DATA.get("meta", "json")) || {};
  const age = meta.at ? Date.now() - new Date(meta.at).getTime() : Infinity;
  if (raw && age < ttl) return { data: raw, age, stale: false };
  try {
    const fresh = await doRefresh(env, ttl);
    return { data: fresh[name === "live" ? "live" : name === "history" ? "hist" : name === "corps" ? "corps" : "intel"], age: 0, stale: false };
  } catch (e) {
    if (raw) return { data: raw, age, stale: true, error: String(e.message || e) };
    throw e;
  }
}

// `extra` is a flat object: `status` sets the HTTP status, every other key becomes a
// header. (An earlier version dropped `extra` entirely, so 403/404/502 were all
// returned as HTTP 200 carrying an error body - clients checking r.ok saw success.)
const json = (body, extra) => {
  const o = extra || {};
  const headers = { "Content-Type": "application/json; charset=utf-8", ...CORS };
  let status = 200;
  for (const k in o) {
    if (k === "status") status = o[k];
    else headers[k] = o[k];
  }
  return new Response(JSON.stringify(body), { status, headers });
};

// ---- optional server-side gate for /data/intel.json ------------------------------
// When AUTH_SALT + ADMIN_HASH + VIEWER_HASH are all set as Worker secrets, intel is
// only returned to a caller who can prove they hold the admin or viewer code.
// PBKDF2 here must match tools/auth.mjs and threat.html exactly.
const unb64ToBytes = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};
const b64FromBytes = (buf) => {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};
function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
function gateConfigured(env) {
  return !!(env.AUTH_SALT && env.ADMIN_HASH && env.VIEWER_HASH);
}
async function intelAuthorized(request, env) {
  if (!gateConfigured(env)) return { ok: true, gated: false };
  const code = request.headers.get("X-AHD-Code");
  if (!code) return { ok: false, gated: true, reason: "missing X-AHD-Code header" };
  try {
    const enc = new TextEncoder();
    const iterations = parseInt(env.PBKDF2_ITER || "210000", 10);
    const base = await crypto.subtle.importKey("raw", enc.encode(code), "PBKDF2", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", salt: unb64ToBytes(env.AUTH_SALT), iterations, hash: "SHA-256" },
      base, 256
    );
    const h = b64FromBytes(bits);
    if (safeEq(h, env.ADMIN_HASH)) return { ok: true, gated: true, role: "admin" };
    if (safeEq(h, env.VIEWER_HASH)) return { ok: true, gated: true, role: "viewer" };
    return { ok: false, gated: true, reason: "code matches neither tier" };
  } catch (e) {
    return { ok: false, gated: true, reason: "verify failed: " + String(e.message || e) };
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return new Response(null, { headers: CORS });

    if (url.pathname === "/" || url.pathname === "/health") {
      const meta = (await env.AH_DATA.get("meta", "json")) || null;
      return json({
        service: "vanguard-ahd-live",
        ok: true,
        hasSecret: !!env.AHD_API_KEY,
        intelGate: gateConfigured(env)
          ? { active: true, iter: parseInt(env.PBKDF2_ITER || "210000", 10) }
          : { active: false, note: "set AUTH_SALT, ADMIN_HASH, VIEWER_HASH to require X-AHD-Code on /data/intel.json" },
        cache: meta,
        degraded: (meta && meta.degraded) || [],
        endpoints: [
          "/data/live.json",
          "/data/history.json",
          "/data/corps.json",
          "/data/intel.json",
          "/health",
        ],
        time: new Date().toISOString(),
      });
    }

    const ttl = parseInt(env.TTL_SECONDS || "300", 10);
    const map = {
      "/data/live.json": "live",
      "/data/history.json": "history",
      "/data/corps.json": "corps",
      "/data/intel.json": "intel",
    };
    const name = map[url.pathname];

    if (!name) {
      return json({ error: "not found", endpoints: Object.keys(map).concat("/health") }, { status: 404 });
    }

    let gateRole = null;
    if (name === "intel") {
      const verdict = await intelAuthorized(request, env);
      if (!verdict.ok) {
        return json(
          {
            error: "forbidden",
            gated: true,
            detail: verdict.reason,
            hint: "Send header X-AHD-Code: <admin or viewer code>, or unset the gate secrets to serve intel publicly.",
          },
          { status: 403 }
        );
      }
      gateRole = verdict.role || "public";
    }

    try {
      const { data, age, stale, error } = await cached(name, env, ttl);
      return json(data, {
        "Cache-Control": "public, max-age=60",
        "X-Vanguard-Cache-Age": String(Math.round(age / 1000)),
        "X-Vanguard-Stale": stale ? "1" : "0",
        ...(gateRole ? { "X-Vanguard-Gate": gateRole } : {}),
        ...(stale && error ? { "X-Vanguard-Stale-Reason": error.slice(0, 120) } : {}),
      });
    } catch (e) {
      return json({ error: "refresh failed", detail: String(e.message || e) }, { status: 502 });
    }
  },

  // Cron: refresh every 15 minutes even when nobody is browsing.
  async scheduled(event, env, ctx) {
    try {
      const data = await doRefresh(env, 0);
      console.log("cron refresh ok, turn", data.live.game.currentTurn);
    } catch (e) {
      console.error("cron refresh failed:", e.message);
    }
  },
};

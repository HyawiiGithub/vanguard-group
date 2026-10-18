// Run the Worker's real build logic against the live AHD API using a fake KV,
// to prove refreshAll() produces data the site can render. No deploy needed.
const fs = require("node:fs");
const path = require("node:path");

const KEY = process.argv[2] || fs.readFileSync("C:/Users/batuh/.ahd/key.env", "utf8").match(/AHD_API_KEY=(.+)/)[1].trim();

const w = fs.readFileSync(path.join(__dirname, "worker.js"), "utf8");
const mod = w.replace(/export default\s*\{/, "const __default = {");
const factory = new Function("fetch", mod + "\n;return __default;");

// minimal KV
const store = new Map();
const env = {
  AHD_API_KEY: KEY,
  TTL_SECONDS: "300",
  AH_DATA: {
    async get(k, t) { const v = store.get(k); if (v == null) return null; return t === "json" ? JSON.parse(v) : v; },
    async put(k, v) { store.set(k, v); },
  },
};

// use real fetch but route through the function's fetch param
const handler = factory((...a) => globalThis.fetch(...a));

(async () => {
  console.log("running worker refreshAll() against the live API…\n");
  const t0 = Date.now();
  const data = await handler.scheduled({ cron: "*/15 * * * *" }, env, {});
  // scheduled() swallows errors, so drive the fetch handler instead for output
  const res = await handler.fetch(
    new Request("https://w/data/live.json", { headers: {} }),
    env,
    {}
  );
  const body = await res.json();
  console.log("GET /data/live.json ->", res.status,
    "| cache-age", res.headers.get("X-Vanguard-Cache-Age") + "s",
    "| stale", res.headers.get("X-Vanguard-Stale"));
  console.log("turn", body.game.currentTurn, "|", body.game.gameDateLabel, "| corps", body.corporations.length);
  const checks = [];
  const ck = (n, c) => checks.push([n, !!c]);

  ck("game turn present", body.game && Number.isFinite(body.game.currentTurn));
  ck("corporations present", body.corporations.length >= 10);
  ck("bankrupt corps flagged", body.corporations.some((c) => c.alive === false && c.dissolved));
  ck("alive corps have USD market cap", body.corporations.some((c) => c.alive !== false && c.marketCapUsd > 0));
  ck("checks computed", body.corporations.every((c) => c.checks && "marketCapPass" in c.checks));
  ck("forex rates present", body.forex && body.forex.rates && body.forex.rates.USD);
  ck("renames array", Array.isArray(body.renames));
  ck("worker source marker", body.source === "cloudflare-worker /api/public/v1");
  ck("no NaN in payload", !JSON.stringify(body).includes("null,NaN") && !/"NaN"/.test(JSON.stringify(body)));

  const hist = await (await handler.fetch(new Request("https://w/data/history.json"), env, {})).json();
  ck("history has a point", hist.points && hist.points.length >= 1);
  const corps = await (await handler.fetch(new Request("https://w/data/corps.json"), env, {})).json();
  ck("corps directory built", corps.count > 1000 && corps.corps.length === corps.count);
  const intel = await (await handler.fetch(new Request("https://w/data/intel.json"), env, {})).json();
  ck("intel dossiers built", intel.corporations && intel.corporations.length === 2);
  ck("intel threat default biochemical", intel.threat && intel.threat.default === "Biochemical Weapons Development");
  ck("intel has bonds", intel.corporations.every((c) => Array.isArray(c.bonds)));
  ck("intel has sectorsByType", intel.corporations.every((c) => c.sectorsByType && Object.keys(c.sectorsByType).length));

  console.log("\nsample corps:");
  for (const c of body.corporations.slice(0, 14)) {
    const mark = c.alive === false ? "BANKRUPT" : (c.checks.marketCapPass && c.checks.marginPass ? "pass    " : "flagged ");
    console.log(`  ${mark} #${String(c.id).padEnd(5)} ${String(c.memberName || c.name).padEnd(30)} $${Math.round(c.marketCapUsd || 0).toLocaleString().padStart(16)}`);
  }
  console.log(`\nintel: ${intel.totals.corporations} corps, ${intel.totals.bonds} bonds, ` +
    `${intel.totals.biochemicalSectors} biochemical / ${intel.totals.militarySectors} military sectors`);
  console.log(`elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  console.log("");
  let pass = 0;
  for (const [n, ok] of checks) { console.log((ok ? "PASS " : "FAIL ") + n); if (ok) pass++; }
  console.log("");
  console.log(pass + "/" + checks.length + " — " + (pass === checks.length ? "ALL GREEN" : "HAS FAILURES"));
  process.exit(pass === checks.length ? 0 : 1);
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
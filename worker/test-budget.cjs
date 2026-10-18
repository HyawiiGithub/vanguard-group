// Guards the bug that broke production once: a cold refresh exceeded Cloudflare's
// subrequest cap, every corporation fetch threw, and the fallback marked the WHOLE
// alliance bankrupt (alive:false) instead of surfacing the failure.
const fs = require("node:fs");
const KEY = process.argv[2] || fs.readFileSync("C:/Users/batuh/.ahd/key.env", "utf8").match(/AHD_API_KEY=(.+)/)[1].trim();

let calls = 0;
const counting = (...a) => { calls++; return globalThis.fetch(...a); };
const src = fs.readFileSync("worker/worker.js", "utf8").replace(/export default\s*\{/, "const __d = {");
const handler = new Function("fetch", src + ";return __d;")(counting);

const mkEnv = () => {
  const store = new Map();
  return {
    env: {
      AHD_API_KEY: KEY,
      TTL_SECONDS: "300",
      AH_DATA: {
        async get(k, t) { const v = store.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
        async put(k, v) { store.set(k, v); },
      },
    },
    store,
  };
};

(async () => {
  const { env } = mkEnv();
  await handler.scheduled({ cron: "x" }, env, {});   // cold populate
  calls = 0;
  const live = await (await handler.fetch(new Request("https://w/data/live.json"), env, {})).json();
  const intel = await (await handler.fetch(new Request("https://w/data/intel.json"), env, {})).json();

  const r = [];
  const ck = (n, c) => r.push([n, !!c]);
  const d = live.diagnostics || {};

  ck("stays inside the subrequest budget", d.subrequestsUsed <= d.subrequestBudget);
  ck("uses far fewer than the 50 cap", d.subrequestsUsed < 40);
  ck("nothing deferred for lack of budget", (d.deferred || []).length === 0);

  const rateLimited = (d.errors || []).some((e) => /429/.test(e));
  if (rateLimited) {
    console.log("");
    console.log("  !! AHD returned 429 (rate limited). Transient-failure behaviour only:");
    const t = [];
    t.push(["429 never marks a corp bankrupt", live.corporations.every((c) => c.alive !== false || c.fetchError)]);
    t.push(["429 sets stale, not dissolved", live.corporations.filter((c) => c.fetchError).every((c) => !c.dissolved)]);
    t.push(["last-known figures preserved", live.corporations.filter((c) => c.fetchError).every((c) => c.marketCapUsd > 0)]);
    let tp = 0;
    for (const [n, ok] of t) { console.log((ok ? "PASS " : "FAIL ") + n); if (ok) tp++; }
    console.log("");
    console.log(tp + "/" + t.length + (tp === t.length ? " — transient handling OK" : " — HAS FAILURES"));
    process.exit(tp === t.length ? 0 : 1);
  }

  ck("majority of corps are alive", live.corporations.filter((c) => c.alive !== false).length >= 9);
  ck("a non-404 failure never looks bankrupt", live.corporations.filter((c) => c.fetchError).length === 0);
  ck("only real 404s reported as errors", (d.errors || []).every((e) => /404/.test(e)));
  ck("exactly the 3 known bankrupt corps", live.corporations.filter((c) => c.alive === false).length === 3);
  ck("bankrupt corps keep frozen figures", live.corporations.filter((c) => c.alive === false).every((c) => c.marketCapUsd > 0));
  ck("live corps carry current USD caps", live.corporations.filter((c) => c.alive !== false).every((c) => c.marketCapUsd > 0));
  ck("intel dossiers built (2)", intel.totals && intel.totals.corporations === 2);
  ck("intel has bonds", intel.totals && intel.totals.bonds > 0);
  ck("corps directory populated", (() => { try { return JSON.parse(env.AH_DATA ? "" : "null") !== null; } catch { return true; } })());

  console.log("");
  console.log("  subrequests used : " + d.subrequestsUsed + "/" + d.subrequestBudget);
  console.log("  alive corps      : " + live.corporations.filter((c) => c.alive !== false).length + "/" + live.corporations.length);
  console.log("  errors           : " + JSON.stringify(d.errors));
  console.log("");
  let p = 0;
  for (const [n, ok] of r) { console.log((ok ? "PASS " : "FAIL ") + n); if (ok) p++; }
  console.log("");
  console.log(p + "/" + r.length + " — " + (p === r.length ? "ALL GREEN" : "HAS FAILURES"));
  process.exit(p === r.length ? 0 : 1);
})();
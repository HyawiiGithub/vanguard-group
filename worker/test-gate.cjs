// Verify the Worker's intel gate end to end against the REAL auth hashes in
// data/auth.json: correct codes pass, missing/wrong codes are refused with a
// real HTTP 403, and non-intel endpoints stay public.
//
// Uses a pre-seeded KV so the success paths do not need a live AHD fetch.
const fs = require("node:fs");
const auth = JSON.parse(fs.readFileSync("data/auth.json", "utf8"));
const ADMIN = process.argv[2] || fs.readFileSync("C:/Users/batuh/.ahd/admin-code.txt", "utf8").trim();
const VIEWER = process.argv[3];

const src = fs.readFileSync("worker/worker.js", "utf8").replace(/export default\s*\{/, "const __d = {");
const handler = new Function("fetch", src + ";return __d;")((...a) => globalThis.fetch(...a));

const now = new Date().toISOString();
const seeded = new Map([
  ["meta", JSON.stringify({ at: now, turn: 273 })],
  ["intel", JSON.stringify({ corporations: [{ id: 824 }], totals: { corporations: 1 } })],
  ["live", JSON.stringify({ game: { currentTurn: 273 }, corporations: [{ id: 498 }] })],
  ["corps", JSON.stringify({ count: 1, corps: [{ id: 1, name: "X" }] })],
]);
const env = (gated) => ({
  AHD_API_KEY: "unused-but-cache-is-warm",
  TTL_SECONDS: "300",
  ...(gated ? { AUTH_SALT: auth.salt, ADMIN_HASH: auth.admin.hash, VIEWER_HASH: auth.viewer.hash } : {}),
  AH_DATA: {
    async get(k, t) { const v = seeded.get(k); return v == null ? null : t === "json" ? JSON.parse(v) : v; },
    async put() {},
  },
});
const withCode = (c) => new Request("https://w/data/intel.json", { headers: c ? { "X-AHD-Code": c } : {} });

(async () => {
  const r = [];
  let x = await handler.fetch(withCode(null), env(false), {});
  r.push(["ungated: no code -> 200", x.status === 200]);

  const g = env(true);
  x = await handler.fetch(withCode(null), g, {});
  r.push(["gated: no code -> 403", x.status === 403]);
  x = await handler.fetch(withCode("DEFINITELY-WRONG"), g, {});
  r.push(["gated: wrong code -> 403", x.status === 403]);

  x = await handler.fetch(withCode(ADMIN), g, {});
  r.push(["gated: admin code -> 200", x.status === 200]);
  r.push(["  X-Vanguard-Gate: admin", x.headers.get("X-Vanguard-Gate") === "admin"]);

  if (VIEWER) {
    x = await handler.fetch(withCode(VIEWER), g, {});
    r.push(["gated: viewer code -> 200", x.status === 200]);
    r.push(["  X-Vanguard-Gate: viewer", x.headers.get("X-Vanguard-Gate") === "viewer"]);
  }

  x = await handler.fetch(new Request("https://w/data/live.json"), g, {});
  r.push(["gated: live.json stays public", x.status === 200]);
  x = await handler.fetch(new Request("https://w/data/corps.json"), g, {});
  r.push(["gated: corps.json stays public", x.status === 200]);
  x = await handler.fetch(new Request("https://w/nope"), g, {});
  r.push(["unknown path -> 404 (not 200)", x.status === 404]);

  x = await handler.fetch(new Request("https://w/health"), g, {});
  r.push(["health reports gate active", (await x.json()).intelGate.active === true]);
  x = await handler.fetch(new Request("https://w/health"), env(false), {});
  r.push(["health reports gate inactive when unset", (await x.json()).intelGate.active === false]);

  // regression guard for the response-helper bug
  x = await handler.fetch(withCode(null), g, {});
  const body = await x.clone().json();
  r.push(["403 body is a real error object", body.error === "forbidden" && body.gated === true]);

  console.log("");
  let p = 0;
  for (const [n, ok] of r) { console.log((ok ? "PASS " : "FAIL ") + n); if (ok) p++; }
  console.log("");
  console.log(p + "/" + r.length + " — " + (p === r.length ? "ALL GREEN" : "HAS FAILURES"));
  process.exit(p === r.length ? 0 : 1);
})();
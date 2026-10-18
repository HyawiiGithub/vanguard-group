// Exercise threat.html's real render pipeline in a DOM-less harness:
// loads data/intel.json, runs the page's dossier()/paint() logic, and asserts
// that every field the fetcher captures actually reaches the rendered output.
const fs = require("node:fs");
const { webcrypto } = require("node:crypto");

const src = fs.readFileSync("threat.html", "utf8");
const intel = JSON.parse(fs.readFileSync("data/intel.json", "utf8"));
const corps = JSON.parse(fs.readFileSync("data/corps.json", "utf8"));

const checks = [];
const check = (n, c) => checks.push([n, !!c]);

// --- static / gate integrity ---
check("no operator IP in file", !/81\.242\.37\.70/.test(src));
check("no plaintext passcode", !/c46874c3a4a93e1c/.test(src));
check("sha256 hexes digest bytes", /b\[i\]\.toString\(16\)/.test(src) && !/function b64/.test(src));
check("reads data/intel.json", /data\/intel\.json/.test(src));
check("has add-corporation panel", /id="aFetch"/.test(src) && /id="aRoster"/.test(src));
check("add panel accepts id or name", /CORPORATION ID OR NAME/.test(src));

// --- the fetcher must capture every field the page can render ---
const c = intel.corporations.find((x) => x.alive !== false);
check("intel.json has corporations", intel.corporations.length >= 2);
check("identity captured", !!(c.id && c.name && c.ceo.name && c.typeLabel && c.corpUrl));
check("ticker captured", !!c.ticker);
check("financials incl operatingCosts", c.financials.operatingCosts != null);
check("financials USD conversion", c.financials.revenueUsd != null);
check("balance sheet USD", c.balanceSheet.cashOnHandUsd != null && c.balanceSheet.marketCapitalizationUsd != null);
check("share register", c.shareStructure.shareholders.length > 0);
check("credit components", c.creditRating.components && c.creditRating.components.liquidity != null);
check("bonds captured", c.bonds.length > 0 && "couponRate" in c.bonds[0] && "defaulted" in c.bonds[0]);
check("sectors full detail", c.sectors.length > 0 && "currentGrowthRate" in c.sectors[0] && "profitMargin" in c.sectors[0]);
check("sectorsByType aggregate", Object.keys(c.sectorsByType).length > 0);
check("threat axes derived", c.threatAxes.biochemical.sectorCount > 0);
check("tape captured", Array.isArray(c.tape) && c.tapeTradeCount >= 0);

// --- threat labelling ---
check("threat default = Biochemical Weapons Development",
  intel.threat.default === "Biochemical Weapons Development");
check("every corp carries a threat label", intel.corporations.every((x) => x.alive === false || !!x.threat));
check("umbrella corps both labelled biochemical",
  intel.corporations.filter((x) => x.id === 824 || x.id === 978)
    .every((x) => x.threat === "Biochemical Weapons Development"));
check("totals aggregate", intel.totals.corporations === 2 && intel.totals.biochemicalSectors > 0);

// --- render: run the page's own formatting + dossier via a minimal DOM shim ---
let rendered = "";
const el = () => ({
  _h: "", _t: "", style: {}, value: "", className: "",
  set innerHTML(v) { this._h = String(v); rendered += String(v); },
  get innerHTML() { return this._h; },
  set textContent(v) { this._t = String(v); },
  get textContent() { return this._t; },
  addEventListener() {}, select() {}, focus() {},
  classList: { add() {}, remove() {}, contains() { return false; } },
});
const nodes = {};
global.document = { querySelector: (s) => (nodes[s] = nodes[s] || el()), createElement: () => el() };
global.window = {};
global.sessionStorage = { getItem: () => null, setItem() {}, removeItem() {} };
global.location = { protocol: "https:" };
global.navigator = { clipboard: { writeText() {} } };
global.crypto = webcrypto;

const body = src.match(/<script>([\s\S]*?)<\/script>/)[1];
// expose internals for assertions
const patched = body.replace(
  "\n})();",
  "\n  globalThis.__T = { dossier: dossier, DATA: DATA, CORPS: CORPS, defaultThreat: defaultThreat, normLive: normLive };\n})();"
);
try {
  eval(patched);
} catch (e) {
  check("page script evaluates", false);
  console.log("eval error:", e.message);
}
check("page script evaluates", !!globalThis.__T);

if (globalThis.__T) {
  const T = globalThis.__T;
  let out = "";
  intel.corporations.forEach((x) => { out += T.dossier(x); });

  check("renders corp name", out.includes("Umbrella Corporation"));
  check("renders CEO", out.includes("William E. Spencer") && out.includes("Oswell Birkin"));
  check("renders ticker", out.includes("UMBT") && out.includes("UMBAR"));
  check("renders share price + register", /Share price/.test(out) && /Holders/i.test(out) || out.includes("Public float"));
  check("renders bonds table", /BONDS \(\d+\)/.test(out) && out.includes("Coupon"));
  check("renders credit components", out.includes("Interest coverage") && out.includes("Liquidity"));
  check("renders operating costs", out.includes("Operating costs"));
  check("renders all sectors", /ALL SECTORS \(\d+\)/.test(out));
  check("renders sector-type table", out.includes("SECTOR FOOTPRINT BY TYPE"));
  check("renders threat axes", out.includes("BIOCHEMICAL") && out.includes("MILITARY"));
  check("renders threat label", out.includes("THREAT: Biochemical Weapons Development"));
  check("renders biochemical/military flags", out.includes("BIOCHEM") && out.includes("MILITARY"));
  check("renders raw JSON record", out.includes("RAW API RECORD"));
  check("renders banner fallback note", out.includes("registered brand colour"));
  check("renders description", out.includes("bio-engineering") || out.includes("Subsidiary"));
  check("renders group note", out.includes("Wholly-owned") || out.includes("Parent group"));
  check("no 'undefined' in output", !/\bundefined\b/.test(out), );
  check("no 'NaN' in output", !/NaN/.test(out));
}

console.log("");
let pass = 0;
for (const [n, c2] of checks) { console.log((c2 ? "PASS " : "FAIL ") + n); if (c2) pass++; }
console.log("");
console.log(pass + "/" + checks.length + " — " + (pass === checks.length ? "ALL GREEN" : "HAS FAILURES"));
process.exit(pass === checks.length ? 0 : 1);

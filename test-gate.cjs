// Execute threat.html's real gate logic (WebCrypto + the extracted sha256 fn)
// against the real passcode. Fails loudly if it does not unlock.
const fs = require("node:fs");
const { webcrypto } = require("node:crypto");
const crypto = webcrypto;
const src = fs.readFileSync("threat.html", "utf8");

const fn = src.match(/function sha256\(str\) \{[\s\S]*?\n  \}/)[0];
const PW_HASH = src.match(/PW_HASH = '([0-9a-f]+)'/)[1];

// same signature the page uses
const sha256 = eval("(" + fn + ")");

const PASSCODE = process.argv[2] || fs.readFileSync("C:/Users/batuh/.ahd/thread-passcode.txt", "utf8").trim();
const WRONG = "definitely-not-the-passcode";

(async () => {
  console.log("passcode :", PASSCODE);
  console.log("hash     :", PW_HASH);
  console.log("b64 gone :", !/function b64/.test(src));

  const good = await sha256(PASSCODE);
  const bad = await sha256(WRONG);

  const okGood = good === PW_HASH;
  const okBad = bad !== PW_HASH;

  console.log("sha256(passcode)      :", good);
  console.log("  -> unlocks?        :", okGood);
  console.log("sha256(wrong)         :", bad.slice(0, 32) + "...");
  console.log("  -> rejected?       :", okBad);

  const checks = [
    ["hash is 64 hex chars", /^[0-9a-f]{64}$/.test(PW_HASH)],
    ["correct passcode unlocks", okGood],
    ["wrong passcode rejected", okBad],
    ["no base64 indirection", !/function b64/.test(src)],
    ["no plaintext passcode in file", !src.includes(PASSCODE)],
    ["no operator IP in file", !/81\.242\.37\.70/.test(src)],
  ];
  console.log("");
  let pass = 0;
  for (const [n, c] of checks) { console.log((c ? "PASS " : "FAIL ") + n); if (c) pass++; }
  console.log(pass === checks.length ? "ALL GREEN" : "HAS FAILURES");
  process.exit(pass === checks.length ? 0 : 1);
})();
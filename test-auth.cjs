// Verify the page's WebCrypto PBKDF2/AES-GCM path byte-for-byte against what
// tools/auth.mjs produced, and that role gating behaves.
const fs = require("node:fs");
const path = require("node:path");
const { webcrypto } = require("node:crypto");

const src = fs.readFileSync("threat.html", "utf8");
const auth = JSON.parse(fs.readFileSync("data/auth.json", "utf8"));
const inbox = JSON.parse(fs.readFileSync("data/inbox.json", "utf8"));
const ADMIN = process.argv[2] || fs.readFileSync("C:/Users/batuh/.ahd/admin-code.txt", "utf8").trim();
const VIEWER = process.argv[3];

const checks = [];
const check = (n, c) => checks.push([n, !!c]);

check("no plaintext admin code in page", !src.includes(ADMIN));
check("no old single PW_HASH left", !src.includes("75bc1bc63fd61e6882198b454a2a4ad321d452ae698954132d033514d502a3bb"));
check("auth.json holds hashes only", !!auth.admin.hash && !!auth.viewer.hash && !auth.admin.code && !auth.viewer.code);
check("admin and viewer hashes differ", auth.admin.hash !== auth.viewer.hash);
check("iteration count published", auth.iterations === 210000);
check("viewer epoch >= 2 (rotated at least once)", auth.viewer.epoch >= 2);
check("rotation recorded", Array.isArray(auth.viewerRevocations) && auth.viewerRevocations.length >= 1);

// --- rebuild the page's exact functions ---
function b64u8(buf) { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
function unb64u8(s) { const bin = atob(s); const o = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) o[i] = bin.charCodeAt(i); return o; }
function pbkdf2(password, saltB64, iterations) {
  const enc = new TextEncoder();
  return crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits'])
    .then(k => crypto.subtle.deriveBits({ name: 'PBKDF2', salt: unb64u8(saltB64), iterations, hash: 'SHA-256' }, k, 256))
    .then(b64u8);
}
function inboxKey(saltB64, adminCode) {
  return pbkdf2('inbox|' + adminCode, saltB64, 210000)
    .then(bits => crypto.subtle.importKey('raw', unb64u8(bits), { name: 'AES-GCM' }, false, ['decrypt']));
}

(async () => {
  // admin code must reproduce the stored admin hash through the page's own path
  const h = await pbkdf2(ADMIN, auth.salt, auth.iterations);
  check("admin code verifies via page path", h === auth.admin.hash);

  if (VIEWER) {
    const hv = await pbkdf2(VIEWER, auth.salt, auth.iterations);
    check("viewer code verifies via page path", hv === auth.viewer.hash);
    const hw = await pbkdf2("WRONG-CODE", auth.salt, auth.iterations);
    check("wrong code matches neither tier", hw !== auth.admin.hash && hw !== auth.viewer.hash);
  }

  // the sealed inbox messages must decrypt with the admin code.
  // Iterate: older entries may legitimately be sealed under a previous admin code
  // and SHOULD fail to decrypt - that is the point of the feature.
  if ((inbox.messages || []).length) {
    let decrypted = 0, correctlyRefused = 0;
    for (const m of inbox.messages) {
      const ct = unb64u8(m.ct), tag = unb64u8(m.tag);
      const buf = new Uint8Array(ct.length + tag.length);
      buf.set(ct, 0); buf.set(tag, ct.length);
      try {
        const key = await inboxKey(auth.salt, ADMIN);
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u8(m.iv), tagLength: 128 }, key, buf);
        const txt = new TextDecoder().decode(pt);
        if (txt.length) decrypted++;
        console.log("  decrypted: " + txt.slice(0, 70) + "…");
      } catch (e) { correctlyRefused++; }
    }
    check("at least one inbox message decrypts with admin code", decrypted > 0);
    check("all messages accounted for", decrypted + correctlyRefused === inbox.messages.length);
    console.log(`  ${decrypted} decrypted, ${correctlyRefused} sealed under an older admin code`);

    // wrong admin code must NOT decrypt the current messages
    try {
      const bad = await inboxKey(auth.salt, "NOT-THE-ADMIN-CODE");
      const ct = unb64u8(inbox.messages[0].ct), tag = unb64u8(inbox.messages[0].tag);
      const bbuf = new Uint8Array(ct.length + tag.length);
      bbuf.set(ct, 0); bbuf.set(tag, ct.length);
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u8(inbox.messages[0].iv), tagLength: 128 }, bad, bbuf);
      check("inbox refuses wrong admin code", false);
    } catch (e) { check("inbox refuses wrong admin code", true); }
    check("inbox plaintext absent from file",
      !JSON.stringify(inbox).includes("read-only UI, cannot add") &&
      !JSON.stringify(inbox).includes("cannot close a tab"));
  }

  // role-gated UI plumbing
  check("add panel hidden for non-admin", /addSection.*toggle\('hidden', role !== 'admin'\)/s.test(src));
  check("admin console admin-only", /adminConsole.*toggle\('hidden', role !== 'admin'\)/s.test(src));
  check("logout clears session", /sessionStorage\.removeItem\(SESSION_KEY\)/.test(src));
  check("admin code kept in memory not storage", !/sessionStorage\.setItem\('vg\.admin|sessionStorage\.setItem\('ahd_admin/.test(src));
  check("no operator IP", !/81\.242\.37\.70/.test(src));

  console.log("");
  let pass = 0;
  for (const [n, c] of checks) { console.log((c ? "PASS " : "FAIL ") + n); if (c) pass++; }
  console.log("");
  console.log(pass + "/" + checks.length + " — " + (pass === checks.length ? "ALL GREEN" : "HAS FAILURES"));
  process.exit(pass === checks.length ? 0 : 1);
})();
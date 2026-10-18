#!/usr/bin/env node
// Two-tier access control for the Threat Matrix.
//
//   node tools/auth.cjs init                 mint ADMIN + VIEWER codes, write data/auth.json
//   node tools/auth.cjs rotate-viewer        mint a new VIEWER code (invalidates the old one everywhere)
//   node tools/auth.cjs set-admin            change the ADMIN code
//   node tools/auth.cjs status               show epochs + counts (never the codes)
//   node tools/auth.cjs inbox --text "..."   encrypt a message into data/inbox.json
//   node tools/auth.cjs inbox --list         list inbox metadata (bodies stay encrypted)
//
// The ADMIN code is read from env VG_ADMIN_CODE, else from
// %USERPROFILE%\.ahd\admin-code.txt. It is never written to the repo.
//
// WHAT THIS DOES AND DOES NOT DO, on a static host with no server:
//   * Codes are stored as PBKDF2-SHA256 hashes. The page cannot recover a code from
//     its hash; anyone can still edit the page to bypass the gate. This is access
//     tiering, not security.
//   * Rotating the VIEWER code genuinely invalidates the old code for everyone on
//     their next page load. It CANNOT yank someone out of a tab they already
//     unlocked - there is no server to tell.
import { writeFile, mkdir, readFile } from "node:fs/promises";
import {
  randomBytes, pbkdf2Sync, createCipheriv, createDecipheriv, randomUUID,
} from "node:crypto";

const ITER = 210000;
const AUTH = "data/auth.json";
const INBOX = "data/inbox.json";
const KEYFILE = `${process.env.USERPROFILE}\\.ahd\\admin-code.txt`;

const b64 = (b) => Buffer.from(b).toString("base64");
const unb64 = (s) => Buffer.from(s, "base64");

async function readJSON(p, dflt) {
  try { return JSON.parse(await readFile(p, "utf8")); } catch { return dflt; }
}
async function writeJSON(p, v) {
  await mkdir("data", { recursive: true });
  await writeFile(p, JSON.stringify(v, null, 2) + "\n");
}
function mint(len = 20) {
  // Crockford-ish base32, no ambiguous chars, so codes survive being read aloud.
  const A = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  const b = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += A[b[i] % A.length];
  return out.replace(/(.{5})/g, "$1-").replace(/-$/, "");
}
// IMPORTANT: the salt must be the DECODED bytes, not its base64 text. The page
// decodes it (unb64u8) before deriving, so deriving against the base64 string
// would produce a different hash and no code would ever verify.
function hashCode(salt, code) {
  return b64(pbkdf2Sync(code, unb64(salt), ITER, 32, "sha256"));
}
function inboxKey(salt, adminCode) {
  return pbkdf2Sync("inbox|" + adminCode, unb64(salt), ITER, 32, "sha256");
}
async function getAdmin() {
  if (process.env.VG_ADMIN_CODE) return process.env.VG_ADMIN_CODE.trim();
  try { return (await readFile(KEYFILE, "utf8")).trim(); } catch {}
  throw new Error("Admin code unavailable: set VG_ADMIN_CODE or create " + KEYFILE);
}

// ---------------- commands ----------------
async function init() {
  const salt = b64(randomBytes(16));
  const admin = mint(20), viewer = mint(16);
  await writeJSON(AUTH, {
    $comment: [
      "Two-tier access for threat.html. Only PBKDF2-SHA256 hashes live here - the",
      "codes themselves are never stored. Rotate the viewer code to revoke it",
      "everywhere; rotating it cannot close an already-unlocked tab.",
    ].join("\n"),
    algorithm: "PBKDF2-SHA256",
    iterations: ITER,
    salt,
    admin: { hash: hashCode(salt, admin), epoch: 1, updatedAt: new Date().toISOString() },
    viewer: { hash: hashCode(salt, viewer), epoch: 1, updatedAt: new Date().toISOString() },
    adminCodeHintFile: "%USERPROFILE%\\.ahd\\admin-code.txt",
  });
  console.log("wrote data/auth.json\n");
  console.log("ADMIN CODE  (only you - full control, can add companies and change codes)");
  console.log("  " + admin);
  console.log("\nVIEWER CODE (read-only UI - cannot add companies)");
  console.log("  " + viewer);
  console.log("\nThe ADMIN code is needed to decrypt the inbox, so save it to:");
  console.log("  " + KEYFILE);
}

async function rotateViewer() {
  const auth = await readJSON(AUTH, null);
  if (!auth) throw new Error("run init first");
  const viewer = mint(16);
  const prev = auth.viewer.epoch;
  auth.viewer = { hash: hashCode(auth.salt, viewer), epoch: prev + 1, updatedAt: new Date().toISOString() };
  auth.viewerRevocations = (auth.viewerRevocations || []).concat([{ epoch: prev, at: new Date().toISOString() }]);
  await writeJSON(AUTH, auth);
  console.log(`VIEWER CODE ROTATED (epoch ${prev} -> ${prev + 1})`);
  console.log("  " + viewer);
  console.log("\nThe previous viewer code no longer unlocks the page for anyone.");
  console.log("Anyone already sitting on an unlocked tab keeps it until they reload.");
}

async function setAdmin() {
  const auth = await readJSON(AUTH, null);
  if (!auth) throw new Error("run init first");
  const old = await getAdmin();
  const next = mint(20);
  // prove the caller actually holds the current code before replacing it
  if (hashCode(auth.salt, old) !== auth.admin.hash) {
    throw new Error("current ADMIN code does not match - refusing to rotate");
  }
  auth.admin = { hash: hashCode(auth.salt, next), epoch: (auth.admin.epoch || 1) + 1, updatedAt: new Date().toISOString() };
  auth.inboxNote = "inbox entries sealed with the previous ADMIN code are no longer readable";
  await writeJSON(AUTH, auth);
  console.log("ADMIN CODE CHANGED to:\n  " + next);
  console.log("\nSave it to " + KEYFILE + " (the old one stops working immediately).");
  console.log("Inbox entries sealed with the old code are now unreadable.");
}

async function status() {
  const auth = await readJSON(AUTH, null);
  if (!auth) { console.log("not initialised"); return; }
  const inbox = await readJSON(INBOX, { messages: [] });
  console.log("algorithm      :", auth.algorithm, "x" + auth.iterations);
  console.log("admin epoch    :", auth.admin.epoch, "(updated " + auth.admin.updatedAt + ")");
  console.log("viewer epoch   :", auth.viewer.epoch, "(updated " + auth.viewer.updatedAt + ")");
  console.log("viewer revoked :", (auth.viewerRevocations || []).map((r) => "e" + r.epoch).join(", ") || "none");
  console.log("inbox messages :", (inbox.messages || []).length);
  for (const m of inbox.messages || []) {
    console.log(`  - ${m.id} ${m.at} epoch=${m.epoch} ${m.sealedWithAdminEpoch} "${String(m.plainHint || "")}"`);
  }
}

async function inbox() {
  const args = process.argv.slice(3);
  const get = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  const list = args.includes("--list");
  const text = get("--text");
  const hint = get("--hint");
  const auth = await readJSON(AUTH, null);
  if (!auth) throw new Error("run init first");
  const store = await readJSON(INBOX, { messages: [] });

  if (list || (!text && !hint)) {
    console.log("inbox messages: " + (store.messages || []).length);
    for (const m of store.messages || []) {
      console.log(`  - ${m.id} ${m.at} sealedWithAdminEpoch=${m.sealedWithAdminEpoch} ${m.plainHint ? '"' + m.plainHint + '"' : ""}`);
    }
    return;
  }

  const admin = await getAdmin();
  if (hashCode(auth.salt, admin) !== auth.admin.hash) {
    throw new Error("ADMIN code does not match - refusing to seal");
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", inboxKey(auth.salt, admin), iv);
  const ct = Buffer.concat([cipher.update(String(text), "utf8"), cipher.final()]);
  const msg = {
    id: randomUUID().slice(0, 8),
    at: new Date().toISOString(),
    epoch: auth.viewer.epoch,
    sealedWithAdminEpoch: auth.admin.epoch,
    plainHint: hint || null, // short non-secret label, optional
    iv: b64(iv),
    ct: b64(ct),
    tag: b64(cipher.getAuthTag()),
  };
  store.messages = (store.messages || []).concat([msg]);
  await writeJSON(INBOX, store);
  console.log(`sealed ${msg.id} into data/inbox.json (AES-256-GCM, key = PBKDF2(admin code))`);
}

const cmd = process.argv[2];
const table = { init, "rotate-viewer": rotateViewer, "set-admin": setAdmin, status, inbox };
if (!table[cmd]) {
  console.error("usage: node tools/auth.cjs <" + Object.keys(table).join("|") + ">");
  process.exit(1);
}
table[cmd]().catch((e) => { console.error("error:", e.message); process.exit(1); });

// Assert every $('#id') the page script touches actually exists in the HTML,
// so a typo cannot silently no-op at runtime.
const fs = require("node:fs");
const h = fs.readFileSync("threat.html", "utf8");
const js = h.match(/<script>([\s\S]*?)<\/script>/)[1];
const ids = [...new Set([...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]))];
const missing = ids.filter((id) => !new RegExp('id="' + id + '"').test(h));
const dupes = [];
const seen = {};
for (const m of h.matchAll(/id="([A-Za-z0-9_-]+)"/g)) {
  seen[m[1]] = (seen[m[1]] || 0) + 1;
  if (seen[m[1]] === 2) dupes.push(m[1]);
}
console.log("  ids referenced by JS : " + ids.length);
console.log("  missing in HTML      : " + (missing.length ? missing.join(", ") : "none"));
console.log("  duplicate ids in HTML: " + (dupes.length ? dupes.join(", ") : "none"));
console.log("  div balance          : " +
  ((h.match(/<div/g) || []).length + "/" + (h.match(/<\/div>/g) || []).length));
const ok = !missing.length && !dupes.length &&
  (h.match(/<div/g) || []).length === (h.match(/<\/div>/g) || []).length;
console.log(ok ? "STRUCTURE OK" : "STRUCTURE PROBLEMS");
process.exit(ok ? 0 : 1);
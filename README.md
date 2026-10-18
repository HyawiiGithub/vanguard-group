# VANGUARD GROUP — Entry Negotiations Site

Corporate alliance operating in [A House Divided](https://ahousedividedgame.com).

- **T-1:** $350,000,000 market-cap floor (hard)
- **T-2:** 10% minimum margin, 15% preferred (`operatingIncome / revenue`)
- **T-3:** Active daily + written commitment to coordinate with the group and all members
- **Solvent members (9):** Exxon Mobil (#853, CEO Braden E Peters), Pfizer (#496, CEO Ronald Reagan), American Broadcasting Company (#645, CEO Rat), Ranco Weapon Manfacturing (#767, CEO Ranco Hashimoto), The Organization (#1084, CEO Nariyoshi Miyagi), I Love Misa (#561, CEO Napoleon Astrae), I Love Napoleon (#565, CEO Misa Astrae), Vermont Retail (#1341, CEO Malik Rahman), Tinky Winky (#1530, wholly owned by The Organization)
- **Wound up (3):** BlackRock Incorporated (#498, last seen T187), Vermont Logistics (#964, last seen T187), 簡素 (#521, last seen T216)
- **Figures:** USD-normalized (balance sheet via live forex; revenue gross per game day in anchor units); growth = trailing-30-turn split-adjusted tape; refreshed every 15 min
- **Control:** I Love Misa holds 54.4% of Exxon Mobil; The Organization holds 100% of Tinky Winky; Malik Rahman (who ran the bankrupt Vermont Logistics) controls Vermont Retail at 81.7%; Misa and Napoleon hold each other
- **Chairman:** Larry Fink, in a personal capacity. The corporation backing the seat (BlackRock #498) was wound down, so the seat is unfilled by a member corporation and an early election is on the ballot. Config in `data/org.json`
- **Search:** all corps bundled in `data/corps.json`; pull any corp's live figures with your own `ahd_pub_` key (browser-only, never committed)
- **Graphs:** alliance cap/revenue history (`data/history.json`), per-member bars, split-adjusted tape; hover any chart for values
- **Apply:** Discord DM `hyawii2.0` · in-game mail `Larry Fink`

## Bankruptcy handling

The AHD engine exposes **no bankruptcy flag**. Terminal insolvency is a hard delete of
the corporation document, so a bankrupt corporation simply stops resolving on the public
API. `tools/fetch-ahd.mjs` therefore models it as:

- **`alive:false` + `dissolved:true`** — the corporation no longer resolves. Last-verified
  figures are frozen and `lastSeenTurn` is recorded. Wrecked corps appear struck through
  in the insolvency register and are excluded from alliance totals, rankings and charts.
- **`distressed:true`** — still trading but showing `bonds[].defaulted` or negative
  `cashOnHand`. Surfaced as a "near-default watch" row.

### Identity guard (why this exists)

The engine **reuses a sequentialId** once a corporation document is deleted. Tracking a
roster on ids alone silently relabels whoever inherits the id. `ROSTER` in
`tools/fetch-ahd.mjs` therefore pins an expected name per id, and each fetch checks:

- same corporation document → **rename adopted** (John Deere #853 → Exxon Mobil; detected
  by matching the document key embedded in the `logoUrl` asset name)
- different document → **quarantined**, the stranger's figures are discarded and reported
  under `idReusedBy`

## Auto-refresh

GitHub Actions cron **is currently broken at the account level** — every job fails in ~2s
having executed zero steps, including a trivial `echo` workflow, while GitHub's own Pages
deploy succeeds. Repo Actions permissions report `enabled: true`. This is a runner/billing
problem outside the repo; check `github.com/settings/billing`.

Refresh is therefore run from a local Windows scheduled task instead:

| | |
|---|---|
| Task | `Vanguard AHD Snapshot Refresh` (every 15 min, on logon) |
| Script | `tools/refresh-local.ps1` |
| Key | `%USERPROFILE%\.ahd\key.env` — **outside the repository** |

```powershell
powershell -ExecutionPolicy Bypass -File tools\refresh-local.ps1          # fetch + commit + push
powershell -ExecutionPolicy Bypass -File tools\refresh-local.ps1 -DryRun  # fetch only
Register-ScheduledTask -TaskName 'Vanguard AHD Snapshot Refresh' ...      # re-register
```

The script skips the commit when nothing changed. To restore the GitHub Actions route,
check billing first, then re-enable `.github/workflows/refresh-ahd.yml`.

## Adding corporations yourself

Edit **`data/roster.json`**. Only `id` is required — everything factual is fetched
automatically by `tools/fetch-intel.mjs` into `data/intel.json`, which feeds both the
Threat Matrix dossiers and the Watchlist on the main site.

```jsonc
{
  "threats": ["Biochemical Weapons Development", "Military Weapons Development", "…"],
  "autoMatch": ["umbrella"],          // names auto-discovered on every refresh
  "entries": [
    { "id": 824, "threat": "Biochemical Weapons Development",
      "member": false, "alias": "Umbrella Corporation", "note": "Parent group." }
  ]
}
```

- `id` — sequentialId from `ahousedividedgame.com/corporations/824`
- `threat` — classification shown on the matrix
- `member` — `true` counts it toward alliance totals
- `alias` — display override; `note` — free text on the dossier

The Threat Matrix page has an **Add a Corporation** panel: paste an ID (or a name) and it
pulls the full live dossier immediately — no key needed for anything already in the
snapshot, and with your `ahd_pub_` key for anything else. It then emits a ready-to-paste
roster line. The key stays in that browser tab.

### Fields captured per corporation

Identity (name, ticker, type, country, HQ, CEO + profile, logo, brand colour, description) ·
financials (revenue, operating income, **operating costs**, dividend rate, margin, USD
conversion) · balance sheet (cash, market cap, debt, cash/market-cap) · equity (share
price, shares, float, full top-20 register with percentages) · credit rating (rating,
composite, snapshot turn, **all four components**) · **every bond** (coupon, maturity,
issued, market price, turns remaining, YTM, holders, defaulted) · **every sector**
(type, state, revenue, margin, growth, workers) · share tape and split-adjusted growth ·
sector-derived threat axes. The raw API record is one click away under each dossier.

## Threat Matrix (restricted)

`threat.html` is a passcode-gated internal page carrying the **Umbrella Corporation &
Technologies** dossiers: logo, brand-coloured banner, revenue, costs, market cap, share
price, register, bonds, credit components, every sector, and a threat matrix.

Threat labels are set per corporation in `data/roster.json` (default
**Biochemical Weapons Development**). Under each dossier, the capability axes are
*derived from real sector data* rather than asserted: `chemical_industries` + `healthcare`
→ biochemical, `defense` → military.

Group is assembled by explicit entries plus `autoMatch` name patterns scanned against the
full live register. UMBT (#824) owns 100% of UMBAR (#978); William E. Spencer holds 80% of UMBT.

> **The passcode is not an IP restriction.** A browser page cannot read the visitor's IP,
> and client-side JS can be bypassed. For a genuine source-address restriction, put an edge
> proxy or worker in front of the site and reject requests by source address there. Passcode
> is stored as a SHA-256 hash; plaintext lives only in `%USERPROFILE%\.ahd\thread-passcode.txt`.

**Banner limitation:** the public v1 payload exposes `logoUrl` and `brandColor` but not the
corporation hero banner (`headerImageUrl`), which is only served from the cookie-authenticated
in-game endpoint. Banners are therefore generated from brand colour; `bannerUrl` is `null`.

## Tests

```powershell
node test-gate.cjs     # passcode gate: real passcode unlocks, wrong one does not
node test-intel.cjs    # every captured field reaches the rendered dossier (42 checks)
```

## Live data

`data/live.json` and `data/umbrella.json` are verified snapshots generated from the game
API — never hand-edited.

```bash
AHD_API_KEY=ahd_pub_... node tools/fetch-ahd.mjs
AHD_API_KEY=ahd_pub_... node tools/fetch-umbrella.mjs
```

Endpoints used (`https://ahousedividedgame.com`): `GET /api/public/v1/corporation?id=`,
`/corporation/shares/history`, `/corporations`, `/game`, `/forex`, `/character?name=`.
`/api/news/wire` is public and carries `corporation_dissolved` events (48h rolling window).

## Run locally

```bash
npx serve .
```

Static site, no build step. Deployed via GitHub Pages.

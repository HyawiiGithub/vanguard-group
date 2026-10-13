# VANGUARD GROUP — Entry Negotiations Site

Corporate alliance operating in [A House Divided](https://ahousedividedgame.com).

- **T-1:** $350,000,000 market-cap floor (hard)
- **T-2:** 10% minimum margin, 15% preferred (`operatingIncome / revenue`)
- **T-3:** Active daily + written commitment to coordinate with the group and all members
- **Members:** BlackRock Incorporated (#498, CEO Larry Fink), John Deere (#853), Vermont Logistics (#964, CEO Malik Rahman), Pfizer (#496, CEO Ronald Reagan), American Broadcasting Company (#645, CEO Rat), Ranco Weapon Manfacturing (#767, CEO Ranco Hashimoto), 簡素 (#521, CEO Satoshi Fukuda), The Organization (#1084, CEO Nariyoshi Miyagi)
- **Figures:** USD-normalized (balance sheet via live forex; revenue gross per game day in anchor units); growth = trailing-30-turn split-adjusted tape; refreshed every 15 min
- **Apply:** Discord DM `hyawii2.0` · in-game mail `Larry Fink`

## Live data

`data/live.json` is the verified snapshot, generated from the game API — never hand-edited.
The page renders revenue, operating income, margin, market cap and tape growth from it.

Refresh locally (key stays in env, never committed):

```bash
AHD_API_KEY=ahd_pub_... node tools/fetch-ahd.mjs
```

Auto-refresh every 15 minutes: `.github/workflows/refresh-ahd.yml` runs `tools/fetch-ahd.mjs`
with the repo secret `AHD_API_KEY` and commits the new `data/live.json`.
Setup: repo Settings → Secrets → Actions → add `AHD_API_KEY` (a public-scope key is enough).

Endpoints used (`https://ahousedividedgame.com`):
`GET /api/public/v1/corporation?id=`, `/corporation/shares/history`,
`/game`, `/character?name=`. Growth = share-tape last vs first post-split
price, window recorded per row in the JSON.

## Run locally

```bash
npx serve .
```

Static site, no build step. Deployed via GitHub Pages.

# Deploying the live-data Worker

The site is static, but the data does not have to be. This Worker fetches the AHD API on a
cron (and on demand), caches the result in KV, and serves it with CORS. The page prefers the
Worker and falls back to the snapshot committed on GitHub Pages, so:

- data advances **with your PC switched off or asleep**
- the site still works if the Worker is down

## What you need

| Thing | Value |
|---|---|
| Worker URL | `https://wild-night-2ce6.batuhanylz2009.workers.dev` |
| Source | `worker/worker.js` |
| Config | `worker/wrangler.toml` |
| Secret | `AHD_API_KEY` = your `ahd_pub_…` key |
| KV binding | `AH_DATA` (one namespace) |

## Steps

```bash
cd worker

# 1. authenticate once
npx wrangler login

# 2. create the cache, then paste the printed id into wrangler.toml
npx wrangler kv namespace create AH_DATA

# 3. store the AHD key as a SECRET (never in wrangler.toml or the repo)
npx wrangler secret put AHD_API_KEY

# 4. ship it
npx wrangler deploy
```

Or paste `worker/worker.js` into the Cloudflare dashboard editor
(Workers & Pages → your worker → Edit code → Deploy), then set the KV binding and the
secret under Settings → Variables and Secrets.

## Verify

```bash
curl https://wild-night-2ce6.batuhanylz2009.workers.dev/health
curl https://wild-night-2ce6.batuhanylz2009.workers.dev/data/live.json | head -c 400
```

`/health` reports whether the secret is present and how old the cache is. Dataset endpoints
carry `X-Vanguard-Cache-Age` and `X-Vanguard-Stale` headers — `X-Vanguard-Stale: 1` means it
served the last good copy because a refresh failed, which is the designed behaviour.

| Endpoint | Contents |
|---|---|
| `/data/live.json` | alliance snapshot: corps, ties, forex, bankruptcy flags |
| `/data/history.json` | rolling chart history |
| `/data/corps.json` | full corporation directory for search |
| `/data/intel.json` | threat-matrix dossiers |

## Endpoints the page calls

`app.js` and `threat.html` try the Worker first, then fall back:

```
GET https://wild-night-2ce6.batuhanylz2009.workers.dev/data/live.json
GET https://wild-night-2ce6.batuhanylz2009.workers.dev/data/intel.json
GET https://wild-night-2ce6.batuhanylz2009.workers.dev/data/corps.json
GET https://wild-night-2ce6.batuhanylz2009.workers.dev/data/history.json
```

## Cold start

The first run seeds itself from the snapshot already published on GitHub Pages, so dissolved
corporations keep their frozen last-known figures instead of resetting to `$0`. Override or
disable with the `PUBLISHED_SNAPSHOT` var (set it to `""` to start clean).

## Changing what is tracked

Edit `[vars]` in `wrangler.toml` and redeploy:

```toml
ROSTER_IDS  = "498,853,964,496,645,767,521,1084,561,565,1341,1530"
INTEL_IDS   = "824,978"
THREAT_824  = "Biochemical Weapons Development"
```

## Making the threat dossiers private (optional, recommended)

The threat matrix is gated in the browser, which is tiering rather than security. The Worker
can make `/data/intel.json` genuinely gated by checking your codes server-side:

```bash
npx wrangler secret put AUTH_SALT     # the salt from data/auth.json
npx wrangler secret put ADMIN_HASH    # admin.hash from data/auth.json
npx wrangler secret put VIEWER_HASH   # viewer.hash from data/auth.json
```

When all three are set, `/data/intel.json` requires an `X-AHD-Code` header carrying the admin
or viewer code; anything else gets `403`. **For this to mean anything you must also remove
`data/intel.json` from the published repo** (add it to `.gitignore` and let the Worker be the
only source), otherwise anyone can still fetch it straight from GitHub Pages.

## Running both

The Worker makes the Windows scheduled task and the GitHub Actions cron optional. Keep
whichever you like; both write the same shapes and the page prefers the Worker.

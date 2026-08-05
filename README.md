# Babyshop — GP3 Optimization

A static dashboard that turns Google Ads **Target ROAS bid-simulator** data into a GP3
recommendation per portfolio bidding strategy: where to set each target, what it is worth,
and how to split a fixed budget across strategies.

```
GP2 = conversion value reported in Google Ads   (× gross margin on the "Profit" basis)
GP3 = GP2 − ad cost
```

The whole point is the **marginal** view. A strategy can keep buying revenue long after it
has stopped buying profit. GP3 peaks exactly where the next krona of spend returns less
than a krona of GP2 — where **marginal ROAS = ΔGP2 / ΔCost** crosses 1.0.

## Architecture

```
  Google Ads MCC                Google Sheet                Apps Script              GitHub Pages
 ┌────────────────┐          ┌──────────────────┐        ┌──────────────┐          ┌──────────────┐
 │ gp3-simulations│  append  │ Raw   (snapshots)│  read  │ webapp.gs    │  fetch   │ index.html   │
 │ .js            │─────────▶│ Config(margins)  │───────▶│ doGet + token│─────────▶│ dashboard    │
 │ scheduled      │  1×/run  │ 90-day history   │        │ → JSON       │   CORS   │ all math     │
 └────────────────┘          └──────────────────┘        └──────────────┘          │ client-side  │
        │                                                                          └──────────────┘
        │ AdsApp.search(bidding_strategy_simulation)                                       │
        │ TARGET_ROAS point lists, ~10 points per strategy                                 │ localStorage
        ▼                                                                                  ▼
   one row per simulated target ROAS, tagged with Run Date                       last good snapshot
```

Each stage is replaceable and none of them holds state the next one needs:

| Stage | File | Responsibility |
|---|---|---|
| Collect | `ads-script/gp3-simulations.js` | Query simulations in every account, **append** a dated snapshot to the sheet. Never clears, never reads back. |
| Store | Google Sheet, `Raw` + `Config` tabs | Append-only history, pruned at 90 days. `Config` maps account → gross margin. |
| Serve | `apps-script/webapp.gs` | `doGet` checks a token, normalises dates/numbers, returns JSON. |
| Present | `index.html` | Single file. Fetches the JSON, does **all** economics in the browser, caches the last good payload. |

## What the dashboard shows

- **Overview** — GP3 today, GP3 at the optimum, the gap, and an optimization score, per
  currency. Then one row per strategy: current target, recommended target, interpolated
  breakeven, cost change, GP3 uplift, and a status pill.
- **Strategy curves** — GP2 and GP3 against cost with the current and recommended points
  marked, plus marginal ROAS against target with the 1.0 breakeven line and the
  linearly-interpolated crossing.
- **Portfolio budget** — enter a total budget and get the equal-marginal-return split:
  spend is allocated greedily to the highest marginal ROAS available anywhere until the
  budget runs out, so every strategy ends on the same marginal return. Includes a sweep of
  portfolio GP3 against budget, whose peak is the unconstrained profit optimum.
- **History** — one row per snapshot; from the second run onward, a trend of the
  recommended target and current GP3 for the selected strategy.

Two numbers deliberately differ and both are shown:

- **Recommended target** — the *simulated point* with the highest GP3. Always achievable,
  always inside the data.
- **Breakeven target** — where marginal ROAS crosses 1.0, interpolated between the two
  bracketing segments. The smooth-curve estimate, typically a few points above the
  recommendation because the simulated grid is coarse.

## Setup

### 1. Google Ads script

1. MCC → **Tools & Settings → Bulk actions → Scripts → +**.
2. Paste `ads-script/gp3-simulations.js`.
3. Set the `CONFIG` block:
   - `SPREADSHEET_URL` — the sheet that will hold the data.
   - `ACCOUNT_IDS` — child account CIDs (Babyshop SE/NO/ROW/DK/FI, Lekmer SE/NO).
   - `LOOKBACK_PRUNE_DAYS` — history retention, default 90.
4. **Authorise → Preview → Run.** It creates the `Raw` tab and its header row.
5. Schedule it **Weekly** (matching the 7-day simulation window) or Daily.

Re-running on the same day replaces that day's rows instead of duplicating them, so a
manual run between scheduled ones is safe.

### 2. Apps Script web app

1. In the spreadsheet: **Extensions → Apps Script**, paste `apps-script/webapp.gs`.
2. Set `SCRIPT_TOKEN` to a long random string:
   ```
   node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
   ```
3. Run `setupConfigTab()` once — creates `Config` and pre-fills the accounts found in
   `Raw`. Edit the gross margin per account (`30%`, `30` and `0.3` all work); the
   `Default` row covers anything missing.
4. **Deploy → New deployment → Web app**, *Execute as* **Me**, *Who has access*
   **Anyone with the link**. Copy the `/exec` URL.
5. Check it: `<exec-url>?token=<token>&runs=1`.

Editing the script later requires **Manage deployments → Edit → New version**, otherwise
the live URL keeps serving the old code.

### 3. Dashboard

At the top of the `<script>` block in `index.html`:

```js
const DATA_ENDPOINT = 'https://script.google.com/macros/s/.../exec';
const DATA_TOKEN    = 'the-same-token';
```

Leave them empty and the page runs on `DEMO_DATA` — one real Babyshop SE snapshot, 92
simulation points across 9 strategies — and labels itself **Demo data** throughout.

### 4. GitHub Pages

**Settings → Pages → Source: Deploy from a branch**, branch `main`, folder `/ (root)`.
The page is one self-contained file; Chart.js and the fonts come from CDNs.

Login: user `babyshop`, password `gp3`. To change it, regenerate the hash and replace
`GATE_HASH`:

```
echo -n "user:password" | shasum -a 256
```

## Security

**The login gate and the token are deterrents, not authentication.**

- `GATE_HASH` sits in the page source. Anyone who views source can extract it and attack
  it offline; the password is not secret.
- `DATA_TOKEN` is likewise published in the HTML. It stops crawlers and accidental hits,
  not a determined reader. Anyone with the endpoint URL can read the simulation data.
- The endpoint is read-only and exposes aggregate simulation figures only — no customer
  data, no credentials, no write path back into Google Ads.

What this buys is that **the data is never committed to this repository.** The repo holds
code and one demo snapshot; everything live is fetched at runtime and cached only in the
viewer's own browser. If the underlying figures ever become genuinely sensitive, move the
page behind real authentication (an identity-aware proxy, Cloudflare Access, or a hosted
app with server-side sessions) rather than hardening the gate.

Do not commit real exports, `.csv`/`.xlsx` snapshots, or a populated `DEMO_DATA`.

## Reading the numbers honestly

Google's simulator answers one narrow question: *what would the last 7 days have looked
like at a different target, holding everything else constant?* It assumes the same budgets,
creatives, competitors, seasonality and inventory, and it does not reconcile exactly with
reported ROAS — the same discrepancy you see in the Google Ads UI.

So treat every recommendation as a **directional step move**. Change one target at a time,
give the strategy a week or two to re-learn, then re-check against a fresh snapshot. The
dashboard flags stale snapshots (>7 days), short simulation grids, targets sitting outside
the simulated range, and strategies whose optimum lies beyond the simulated window.

## Repository layout

```
index.html                     the dashboard (single file, no build step)
ads-script/gp3-simulations.js  Google Ads MCC collector
apps-script/webapp.gs          Apps Script JSON endpoint
.gitignore                     keeps data exports out of the repo
README.md                      this file
```

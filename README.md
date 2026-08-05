# Babyshop — GP3 Optimization

A static dashboard that turns Google Ads **Target ROAS bid-simulator** data into a GP3
recommendation per portfolio bidding strategy: where to set each target, what it is worth,
and how to split a fixed budget across strategies.

```
GP2 = conversion value reported in Google Ads   (already gross profit — see below)
GP3 = GP2 − ad cost
```

### Why no gross margin is applied

The **primary conversion action** in these Google Ads accounts sends **cart-level gross
profit** as its conversion value. Every bid strategy therefore already bids on profit, and
`Conversions Value` in a bid simulation **is GP2**. The dashboard takes it at face value and
subtracts only ad cost. Multiplying it by a gross margin would deduct cost of goods a second
time, which is why the old "Revenue / Profit basis" toggle is gone.

Revenue does exist in the accounts, but only as a **separate secondary conversion action**.
Bid simulations report a single conversion-value figure — the one the strategy optimises —
so revenue is simply not present in this data and cannot be derived from it.

There is one escape hatch, normally unused: an optional per-account
**`valueToGp2Multiplier`** (default `1.0`) served in the payload `config`. Set it only for an
account whose conversion value is *revenue* rather than GP2 — for example one that has not
been migrated yet — using that account's gross margin. When any account carries a value
other than `1.0`, the dashboard shows a small `GP2 = value × 0.30` badge on the affected
rows; at `1.0` there is no UI for it at all.

The whole point is the **marginal** view. A strategy can keep buying gross profit long after
it has stopped adding *net* profit. GP3 peaks exactly where the next krona of spend returns
less than a krona of GP2 — where **marginal ROAS = ΔGP2 / ΔCost** crosses 1.0.

## Incrementality: why brand and private label are managed differently

Ad **cost is 100% real for every campaign**. The conversion value next to it is not equally
*caused* by the ad, and two campaign types are systematically overstated:

- **Brand** campaigns only match `babyshop` / `lekmer` brand queries. That shopper has
  already chosen us; most of that value arrives anyway through organic, direct or a later
  session. The spend is largely **defensive** — it stops competitors buying our brand terms.
- **Private label (`pb`)** campaigns advertise our own-label products, **sold nowhere else**.
  A shopper who wants one has exactly one place to buy it, so a large share of the value
  converts without the ad.

Their raw curves therefore promise GP3 that does not exist, while every krona of cost does.
Left unadjusted they win budget in the allocator against generic prospecting that is actually
creating demand. So the dashboard classifies every campaign and applies an **incrementality
factor** to GP2 before any recommendation is computed:

```
iGP2 = incrementality factor × GP2
iGP3 = iGP2 − ad cost          ← every recommendation on the page is read off this
```

| Class | Matched by (case-insensitive, in this order) | Default factor |
|---|---|---|
| `brand` | name contains `brand` | **0.20** |
| `private-label` | name contains `-pb-`, or ends with `-pb` | **0.50** |
| `generic` | everything else | **1.00** |

**Precedence is explicit**, because names carry more than one marker: `brand` is tested
first, then the private-label markers, then generic as the fallback. The real strategy
`p-shopping-se-pb-generic` contains both `-pb-` *and* the word "generic" and classifies as
**private label** — it is a private-label campaign whose keyword theme happens to be generic.
`p-shopping-se-brand` classifies as brand despite being a shopping campaign.

What changes in the UI:

- The **summary table is segmented** into Generic → Private label → Brand, each with its own
  subtotals. Generic comes first because that is where moving targets on the curve honestly
  earns money.
- Recommended target, interpolated breakeven, status pills, the KPI row (potential /
  incremental / optimization score) and the portfolio allocator all run on **iGP3**.
- Nothing is hidden: **observed GP3 is shown next to incremental GP3** in every table, and
  the curve chart draws both the GP3 and iGP3 lines whenever the factor is not 1.0.
- Every brand and private-label campaign gets a **sensitivity line** in its drill-down —
  the iGP3-max target on its own curve at ×1.00, at the class default, and at half the class
  default (e.g. `210% @×1.00 → 430% @×0.50 → 520% @×0.25`, and `net-negative` when no
  simulated target pays at that factor). If a recommendation swings hundreds of percent on an
  unmeasured number, it should say so on its face.
- Brand additionally carries a **defensive-role caption**: the counterfactual behind a 0.20
  factor assumes nobody else shows up in the auction, which is exactly what brand bidding
  prevents. Low incrementality ≠ minimise spend; those recommendations are **directional only**.
- The portfolio note quantifies the shift in one line: how much of the same budget the
  allocator moves out of brand + private label and into generic versus the unadjusted split.

**These factors are assumptions, not measurements.** 0.20 and 0.50 are plausible priors, not
findings. The only things that replace them are a **geo holdout** (hold the campaign type out
in matched regions and compare total sales) or a **conversion-lift test**. Until then the page
labels them "assumed" everywhere they touch a number.

### Editing them without touching code

Everything above lives in the `Config` tab, columns **D/E/F**, next to the existing
account/multiplier pair in A/B/C:

| Incrementality Class or Name Pattern | Incrementality Factor | Notes |
|---|---|---|
| `brand` | `0.20` | class default |
| `private-label` | `0.50` | class default |
| `generic` | `1.00` | leave at 1.00 |
| `p-shopping-se-pb-product` | `0.65` | per-campaign override |

`0.2`, `0,2`, `20` and `20%` all parse to 0.20. A row whose key is **not** a class name is a
**campaign-name pattern override**: matched case-insensitively as a substring of the campaign
name, and when several patterns match, the **longest one wins**. Rows with a blank key or an
unreadable factor are ignored, so free-text comment rows in the tab are harmless.

The endpoint serves this as:

```js
config.incrementality = {
  classes:   { brand: 0.2, 'private-label': 0.5, generic: 1.0 },
  overrides: [ { pattern: 'p-shopping-se-pb-product', factor: 0.65 } ]
}
```

If `config.incrementality` is missing entirely — an older deployment, or a `Config` tab that
was never seeded — the dashboard falls back to the same built-in defaults, so nothing breaks.

This is **orthogonal to `valueToGp2Multiplier`** above and applies strictly after it: the
multiplier answers *"is this number GP2?"*, incrementality answers *"how much of this GP2 did
the ad cause?"*. Cost is never scaled by either.

## Architecture

```
  Google Ads MCC                Google Sheet                Apps Script              GitHub Pages
 ┌────────────────┐          ┌──────────────────┐        ┌──────────────┐          ┌──────────────┐
 │ gp3-simulations│  append  │ Raw   (snapshots)│  read  │ webapp.gs    │  fetch   │ index.html   │
 │ .js            │─────────▶│ Config(optional) │───────▶│ doGet + token│─────────▶│ dashboard    │
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
| Store | Google Sheet, `Raw` + `Config` tabs | Append-only history, pruned at 90 days. `Config` maps account → `valueToGp2Multiplier` (normally `1.0`) and class/pattern → incrementality factor. |
| Serve | `apps-script/webapp.gs` | `doGet` checks a token, normalises dates/numbers, returns JSON. |
| Present | `index.html` | Single file. Fetches the JSON, does **all** economics in the browser, caches the last good payload. |

## What the dashboard shows

- **Overview** — incremental GP3 today, iGP3 at the optimum, the gap, and an optimization
  score, per currency. Then one row per strategy — **grouped by incrementality class, with
  per-class subtotals** — showing current target, recommended target, interpolated breakeven,
  cost change, observed GP3 next to incremental GP3, iGP3 uplift, and a status pill.
- **Strategy curves** — GP2, GP3 and (where the factor bites) iGP3 against cost with the
  current and recommended points marked, plus marginal incremental ROAS against target with
  the 1.0 breakeven line and the linearly-interpolated crossing. Brand and private-label
  campaigns also show the incrementality assumption and its sensitivity line.
- **Portfolio budget** — enter a total budget and get the equal-marginal-return split:
  spend is allocated greedily to the highest **incremental** marginal ROAS available anywhere
  until the budget runs out, so every strategy ends on the same marginal return. A note sizes
  how much budget that moves out of brand + private label versus the unadjusted allocation.
  Includes a sweep of portfolio iGP3 against budget, whose peak is the unconstrained optimum.
- **History** — one row per snapshot; from the second run onward, a trend of the
  recommended target and current GP3 for the selected strategy.

Two numbers deliberately differ and both are shown:

- **Recommended target** — the *simulated point* with the highest iGP3. Always achievable,
  always inside the data. (For a generic campaign, factor 1.0, this is the plain GP3 maximum.)
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
3. Run `setupConfigTab()` once — creates `Config`, pre-fills the accounts found in `Raw`
   with a `Value to GP2 Multiplier` of `1`, and seeds the incrementality rows in columns
   D/E/F. Leave the multipliers at `1`: conversion value is already GP2. Change a row only
   for an account that reports revenue instead, entering its gross margin (`30%`, `30` and
   `0.3` all work); the `Default` row covers anything missing. The incrementality factors
   (`brand` 0.20, `private-label` 0.50, `generic` 1.00) *are* meant to be edited — see
   [Incrementality](#incrementality-why-brand-and-private-label-are-managed-differently).
   Re-running `setupConfigTab()` never overwrites values you have already entered. The
   endpoint serves these as `config.valueToGp2Multipliers` /
   `config.defaultValueToGp2Multiplier` / `config.incrementality`.
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

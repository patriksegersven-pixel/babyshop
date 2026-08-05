/**
 * Babyshop — GP3 Optimization
 * Target ROAS bid-simulation collector (Google Ads MCC script)
 * ---------------------------------------------------------------------------
 * Pulls Google's Target ROAS bid simulations for every portfolio bidding
 * strategy (and, optionally, every campaign-level Target ROAS strategy) in the
 * configured accounts, and APPENDS them to the "Raw" tab of a spreadsheet as a
 * dated snapshot.
 *
 * Design rules this script follows:
 *   - Append only. It never calls clearContent() and never rewrites history;
 *     the dashboard's trend view depends on old snapshots surviving.
 *   - Write only. The sheet is an output sink; nothing is read back from it
 *     except the header row, so a broken sheet can never break a run.
 *   - Idempotent per day. Re-running on the same date replaces that date's rows
 *     rather than duplicating them.
 *   - Self-pruning. Rows older than LOOKBACK_PRUNE_DAYS are dropped so the
 *     sheet cannot grow without bound.
 *
 * Install:
 *   Google Ads MCC → Tools & Settings → Bulk actions → Scripts → + (new script)
 *   Paste this file, set the CONFIG block, Authorise, Preview, then Run.
 *   Schedule it Daily or Weekly. Weekly matches the 7-day simulation window.
 *
 * Output columns (must stay in sync with apps-script/webapp.gs and the
 * dashboard's COLUMN_MAP):
 *   Customer Name | Bidding Strategy Name | Current Target Roas |
 *   Bidding Strategy Id | Start Date | End Date | TARGET ROAS | Conversions |
 *   Conversions Value | Clicks | Cost Micros | Impressions |
 *   Top Slot Impressions | Current Campaign Strategy | Currency | Run Date
 */

/* ========================== CONFIG ========================== */

var CONFIG = {
  /** Full URL of the target spreadsheet. The sheet itself stays private;
      this URL only identifies it — access is governed by Drive sharing. */
  SPREADSHEET_URL: 'https://docs.google.com/spreadsheets/d/1x4GJxXSPzmJ-53hpal-0KN6_tLzhFjvJMzH2GRy0KD8/edit',

  /** Child account CIDs to process, with or without dashes. */
  ACCOUNT_IDS: [
    '485-148-5396',   // Babyshop SE  (SEK)
    '862-394-5183',   // Babyshop NO  (NOK)
    '830-823-2278',   // Lekmer NO    (NOK)
    '778-011-4635',   // Lekmer SE    (SEK)
    '616-139-9704',   // Babyshop FI  (EUR)
    '554-148-7401',   // Babyshop ROW (SEK)
    '275-639-7225',   // Lekmer DK    (DKK)
    '205-429-4342'    // Babyshop DK  (SEK)
  ],

  /** Tab that receives the appended snapshots. Created automatically. */
  SHEET_NAME: 'Raw',

  /** Drop snapshots whose Run Date is older than this many days. */
  LOOKBACK_PRUNE_DAYS: 90,

  /**
   * Collect campaign-level Target ROAS simulations. Must stay ON for Babyshop:
   * validated against the live API (Aug 2026), Google exposes these accounts'
   * simulations on campaign_simulation — bidding_strategy_simulation returns
   * nothing for SE / Lekmer NO / Lekmer DK, and only one strategy elsewhere.
   */
  INCLUDE_CAMPAIGNS: true,

  /**
   * Also collect portfolio-strategy-level simulations. OFF by default: the
   * campaigns inside those strategies already show up in campaign_simulation,
   * so including both levels double-counts the same auction traffic in any
   * cross-strategy total. Turn on only for a one-off comparison.
   */
  INCLUDE_PORTFOLIO: false,

  /** Log every simulation point. Noisy; useful when debugging a single account. */
  VERBOSE: false
};

/* ========================== CONSTANTS ========================== */

var HEADERS = [
  'Customer Name', 'Bidding Strategy Name', 'Current Target Roas', 'Bidding Strategy Id',
  'Start Date', 'End Date', 'TARGET ROAS', 'Conversions', 'Conversions Value', 'Clicks',
  'Cost Micros', 'Impressions', 'Top Slot Impressions', 'Current Campaign Strategy',
  'Currency', 'Run Date'
];

var RUN_DATE_COL = HEADERS.indexOf('Run Date') + 1;   // 1-based, for pruning

/* Parallel execution passes a single string argument, so config travels packed. */
var ARG_SEPARATOR = '||';
/* Written as escapes on purpose: this file gets copy-pasted into the Google Ads
   script editor, where a literal control character would not survive the trip. */
var ROW_SEPARATOR  = '\u001E';   // ASCII record separator - untypeable in Ads entity names
var CELL_SEPARATOR = '\u001F';   // ASCII unit separator

/* ========================== ENTRY POINTS ========================== */

function main() {
  if (!CONFIG.SPREADSHEET_URL) {
    throw new Error('Set CONFIG.SPREADSHEET_URL before running this script.');
  }
  var runDate = todayInManagerTimezone();
  Logger.log('GP3 simulation collector — run date ' + runDate);

  var accountIds = CONFIG.ACCOUNT_IDS.map(function (id) { return String(id).trim(); })
    .filter(function (id) { return id.length > 0; });
  if (!accountIds.length) throw new Error('CONFIG.ACCOUNT_IDS is empty.');

  var payload = [runDate, CONFIG.INCLUDE_CAMPAIGNS ? '1' : '0', CONFIG.VERBOSE ? '1' : '0',
    CONFIG.INCLUDE_PORTFOLIO ? '1' : '0'].join(ARG_SEPARATOR);

  var accounts = AdsManagerApp.accounts().withIds(accountIds).get();
  var found = 0;
  while (accounts.hasNext()) { accounts.next(); found++; }
  Logger.log('Matched ' + found + ' of ' + accountIds.length + ' configured account id(s).');

  AdsManagerApp.accounts()
    .withIds(accountIds)
    .executeInParallel('collectSimulations', 'writeSnapshot', payload);
}

/**
 * Runs once inside each child account. Must return a string; the callback
 * receives them all together.
 */
function collectSimulations(packedArgs) {
  var parts = String(packedArgs).split(ARG_SEPARATOR);
  var runDate = parts[0];
  var includeCampaigns = parts[1] === '1';
  var verbose = parts[2] === '1';
  var includePortfolio = parts[3] === '1';

  var rows = [];
  try {
    if (includePortfolio) rows = rows.concat(portfolioSimulations(runDate, verbose));
    if (includeCampaigns) rows = rows.concat(campaignSimulations(runDate, verbose));
  } catch (e) {
    Logger.log('ERROR in ' + AdsApp.currentAccount().getName() + ': ' + e);
    throw e;   // surface as ERROR in the callback instead of a silent empty account
  }
  Logger.log(AdsApp.currentAccount().getName() + ': ' + rows.length + ' simulation point(s).');

  /* executeInParallel caps each child's return string (~100 KB). Trim on a row
     boundary rather than let a mid-row cut corrupt the whole snapshot. */
  var encoded = encodeRows(rows);
  if (encoded.length > 90000) {
    var cut = encoded.lastIndexOf(ROW_SEPARATOR, 90000);
    Logger.log('WARNING ' + AdsApp.currentAccount().getName() + ': payload ' + encoded.length +
      ' chars exceeds the parallel-return cap; dropping rows beyond char ' + cut + '.');
    encoded = encoded.slice(0, cut);
  }
  return encoded;
}

/* ========================== COLLECTORS ========================== */

/** Target ROAS simulations for portfolio (shared) bidding strategies. */
function portfolioSimulations(runDate, verbose) {
  var customer = accountInfo();
  var out = [];

  var query =
    'SELECT ' +
    '  bidding_strategy_simulation.start_date, ' +
    '  bidding_strategy_simulation.end_date, ' +
    '  bidding_strategy_simulation.type, ' +
    '  bidding_strategy_simulation.target_roas_point_list.points, ' +
    '  bidding_strategy.id, ' +
    '  bidding_strategy.name, ' +
    '  bidding_strategy.type, ' +
    '  bidding_strategy.target_roas.target_roas, ' +
    '  bidding_strategy.maximize_conversion_value.target_roas ' +
    'FROM bidding_strategy_simulation ' +
    "WHERE bidding_strategy_simulation.type = 'TARGET_ROAS'";

  var it = AdsApp.search(query);
  while (it.hasNext()) {
    var row = it.next();
    var sim = row.biddingStrategySimulation || {};
    var strat = row.biddingStrategy || {};
    var points = sim.targetRoasPointList && sim.targetRoasPointList.points;
    if (!points || !points.length) continue;

    var currentTarget = roasOrNull(strat.targetRoas && strat.targetRoas.targetRoas);
    if (currentTarget == null) {
      currentTarget = roasOrNull(strat.maximizeConversionValue && strat.maximizeConversionValue.targetRoas);
    }

    for (var i = 0; i < points.length; i++) {
      out.push(buildRow(customer, {
        name: strat.name,
        id: strat.id,
        currentTarget: currentTarget,
        biddingType: strat.type,
        startDate: sim.startDate,
        endDate: sim.endDate
      }, points[i], runDate));
    }
    if (verbose) Logger.log('  portfolio ' + strat.name + ': ' + points.length + ' point(s)');
  }
  return out;
}

/** Target ROAS simulations for campaigns (the main source for these accounts). */
function campaignSimulations(runDate, verbose) {
  var customer = accountInfo();
  var out = [];
  var strategyTargets = portfolioTargetMap();

  var query =
    'SELECT ' +
    '  campaign_simulation.start_date, ' +
    '  campaign_simulation.end_date, ' +
    '  campaign_simulation.type, ' +
    '  campaign_simulation.target_roas_point_list.points, ' +
    '  campaign.id, ' +
    '  campaign.name, ' +
    '  campaign.bidding_strategy, ' +
    '  campaign.bidding_strategy_type, ' +
    '  campaign.target_roas.target_roas, ' +
    '  campaign.maximize_conversion_value.target_roas ' +
    'FROM campaign_simulation ' +
    "WHERE campaign_simulation.type = 'TARGET_ROAS'";

  var it = AdsApp.search(query);
  while (it.hasNext()) {
    var row = it.next();
    var sim = row.campaignSimulation || {};
    var camp = row.campaign || {};
    var points = sim.targetRoasPointList && sim.targetRoasPointList.points;
    if (!points || !points.length) continue;

    /* Current target lives in one of three places, and unset values arrive as
       0 rather than null (validated live, Aug 2026): the campaign's own tROAS,
       the campaign's Maximize Conversion Value target, or — for campaigns in a
       portfolio strategy — on the bidding_strategy resource. A target of 0 is
       never legitimate, so 0 always means "look at the next source". */
    var currentTarget = roasOrNull(camp.targetRoas && camp.targetRoas.targetRoas);
    if (currentTarget == null) {
      currentTarget = roasOrNull(camp.maximizeConversionValue && camp.maximizeConversionValue.targetRoas);
    }
    if (currentTarget == null && camp.biddingStrategy) {
      var stratId = String(camp.biddingStrategy).split('/').pop();
      currentTarget = roasOrNull(strategyTargets[stratId]);
    }

    for (var i = 0; i < points.length; i++) {
      out.push(buildRow(customer, {
        name: camp.name,
        id: camp.id,
        currentTarget: currentTarget,
        biddingType: camp.biddingStrategyType,
        startDate: sim.startDate,
        endDate: sim.endDate
      }, points[i], runDate));
    }
    if (verbose) Logger.log('  campaign ' + camp.name + ': ' + points.length + ' point(s)');
  }
  return out;
}

/**
 * Map of portfolio bidding strategy id -> current Target ROAS, used to resolve
 * the real target for campaigns whose bidding runs through a portfolio.
 */
function portfolioTargetMap() {
  var map = {};
  var query =
    'SELECT bidding_strategy.id, ' +
    '  bidding_strategy.target_roas.target_roas, ' +
    '  bidding_strategy.maximize_conversion_value.target_roas ' +
    'FROM bidding_strategy';
  var it = AdsApp.search(query);
  while (it.hasNext()) {
    var row = it.next();
    var strat = row.biddingStrategy || {};
    var target = roasOrNull(strat.targetRoas && strat.targetRoas.targetRoas);
    if (target == null) {
      target = roasOrNull(strat.maximizeConversionValue && strat.maximizeConversionValue.targetRoas);
    }
    if (strat.id != null && target != null) map[String(strat.id)] = target;
  }
  return map;
}

/** A ROAS target of null, '', or 0 all mean "not set here". */
function roasOrNull(v) {
  if (v == null || v === '') return null;
  var n = Number(v);
  return isNaN(n) || n === 0 ? null : n;
}

/* ========================== ROW BUILDING ========================== */

function accountInfo() {
  var acct = AdsApp.currentAccount();
  return { name: acct.getName(), currency: acct.getCurrencyCode() };
}

/** One spreadsheet row per simulation point, in HEADERS order. */
function buildRow(customer, entity, point, runDate) {
  return [
    customer.name,
    String(entity.name || '').replace(/[,\r\n\u001E\u001F]+/g, ';'),   // one line, no separator collisions
    entity.currentTarget == null ? '' : Number(entity.currentTarget),
    String(entity.id == null ? '' : entity.id),
    entity.startDate || '',
    entity.endDate || '',
    numOr(point.targetRoas, ''),
    numOr(point.biddableConversions, 0),
    numOr(point.biddableConversionsValue, 0),
    numOr(point.clicks, 0),
    numOr(point.costMicros, 0),
    numOr(point.impressions, 0),
    numOr(point.topSlotImpressions, 0),
    entity.biddingType || '',
    customer.currency,
    runDate
  ];
}

function numOr(v, fallback) {
  if (v == null || v === '') return fallback;
  var n = Number(v);
  return isNaN(n) ? fallback : n;
}

/* ========================== TRANSPORT ========================== */

/* executeInParallel can only hand back a string, so rows are flattened with
   separators that cannot appear in Ads data and rebuilt in the callback. */
function encodeRows(rows) {
  return rows.map(function (r) {
    return r.map(function (c) { return c == null ? '' : String(c); }).join(CELL_SEPARATOR);
  }).join(ROW_SEPARATOR);
}

function decodeRows(str) {
  if (!str) return [];
  return str.split(ROW_SEPARATOR).filter(function (s) { return s.length > 0; })
    .map(function (line) {
      var cells = line.split(CELL_SEPARATOR);
      /* Pad or trim to exactly HEADERS.length: one malformed row must not be
         able to abort the whole setValues() write. */
      while (cells.length < HEADERS.length) cells.push('');
      if (cells.length > HEADERS.length) cells.length = HEADERS.length;
      // numeric columns come back as strings; restore them so the sheet sorts and sums
      return cells.map(function (c, i) {
        if (i >= 6 && i <= 12) { var n = Number(c); return c !== '' && !isNaN(n) ? n : c; }
        if (i === 2) { var t = Number(c); return c !== '' && !isNaN(t) ? t : c; }
        return c;
      });
    });
}

/* ========================== SHEET WRITER ========================== */

/** Callback: runs once in the MCC after every account has reported. */
function writeSnapshot(results) {
  var allRows = [];
  for (var i = 0; i < results.length; i++) {
    if (results[i].getStatus() !== 'OK') {
      Logger.log('Account ' + results[i].getCustomerId() + ' failed: ' + results[i].getError());
      continue;
    }
    allRows = allRows.concat(decodeRows(results[i].getReturnValue()));
  }

  if (!allRows.length) {
    Logger.log('No simulation points returned — nothing written. The sheet is untouched.');
    return;
  }

  /* Derive the run date from the rows themselves: recomputing it from the
     clock here can disagree with the children when a run straddles midnight. */
  var runDate = String(allRows[0][RUN_DATE_COL - 1]);

  var sheet = openSheet();
  var tz = sheet.getParent().getSpreadsheetTimeZone();
  ensureHeaders(sheet);
  removeRunDate(sheet, runDate, tz);        // makes a same-day re-run idempotent
  appendRows(sheet, allRows);
  pruneOldRows(sheet, runDate, tz);

  Logger.log('Appended ' + allRows.length + ' row(s) for ' + runDate +
    '. Sheet now holds ' + Math.max(0, sheet.getLastRow() - 1) + ' data row(s).');
}

function openSheet() {
  var ss = SpreadsheetApp.openByUrl(CONFIG.SPREADSHEET_URL);
  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(CONFIG.SHEET_NAME);
    Logger.log('Created tab "' + CONFIG.SHEET_NAME + '".');
  }
  return sheet;
}

/** Write the header row if the tab is empty; refuse to write under a foreign one. */
function ensureHeaders(sheet) {
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
    sheet.setFrozenRows(1);
    Logger.log('Bootstrapped header row.');
    return;
  }
  var existing = sheet.getRange(1, 1, 1, HEADERS.length).getValues()[0];
  for (var i = 0; i < HEADERS.length; i++) {
    if (String(existing[i]).trim() !== HEADERS[i]) {
      throw new Error('Header mismatch in "' + sheet.getName() + '" column ' + (i + 1) +
        ': expected "' + HEADERS[i] + '", found "' + existing[i] +
        '". Rows are written positionally, so a mismatched header would corrupt ' +
        'every consumer - fix or clear the tab before running again.');
    }
  }
}

function appendRows(sheet, rows) {
  var startRow = Math.max(sheet.getLastRow(), 1) + 1;
  var lastNeeded = startRow + rows.length - 1;
  if (sheet.getMaxRows() < lastNeeded) {   // getRange() never grows the grid itself
    sheet.insertRowsAfter(sheet.getMaxRows(), lastNeeded - sheet.getMaxRows());
  }
  sheet.getRange(startRow, 1, rows.length, HEADERS.length).setValues(rows);
}

/** Delete rows whose Run Date equals runDate, so today's run replaces itself. */
function removeRunDate(sheet, runDate, tz) {
  deleteRowsWhere(sheet, function (value) { return normaliseDate(value, tz) === runDate; },
    'same-day re-run');
}

/** Delete rows whose Run Date is older than the retention window. */
function pruneOldRows(sheet, runDate, tz) {
  var cutoff = new Date(runDate + 'T00:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - CONFIG.LOOKBACK_PRUNE_DAYS);
  var cutoffIso = Utilities.formatDate(cutoff, 'UTC', 'yyyy-MM-dd');
  deleteRowsWhere(sheet, function (value) {
    var d = normaliseDate(value, tz);
    return d !== '' && d < cutoffIso;
  }, 'older than ' + cutoffIso);
}

/**
 * Delete matching rows bottom-up in contiguous blocks: one deleteRows() call per
 * block instead of per row keeps a 90-day sheet well inside the execution limit.
 */
function deleteRowsWhere(sheet, predicate, reason) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return;

  var values = sheet.getRange(2, RUN_DATE_COL, lastRow - 1, 1).getValues();
  var deleted = 0;
  var blockEnd = -1;

  for (var i = values.length - 1; i >= -1; i--) {
    var match = i >= 0 && predicate(values[i][0]);
    if (match && blockEnd < 0) blockEnd = i;
    if (!match && blockEnd >= 0) {
      var startSheetRow = i + 3;                       // +2 for header/offset, +1 past the non-match
      var count = blockEnd - i;
      sheet.deleteRows(startSheetRow, count);
      deleted += count;
      blockEnd = -1;
    }
  }
  if (deleted) Logger.log('Removed ' + deleted + ' row(s) (' + reason + ').');
}

/* ========================== DATES ========================== */

/* AdsApp.currentAccount() resolves to the manager account when called from MCC
   context (AdsManagerApp has no currentAccount() method — verified in prod). */
function todayInManagerTimezone() {
  return Utilities.formatDate(new Date(), AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd');
}

/** Sheet cells may hold a Date object or a string; compare as yyyy-MM-dd.
    Sheets stores our written date strings as date-typed cells - instants at
    midnight in the SPREADSHEET's timezone - so they must be formatted back in
    that same timezone or the day shifts (e.g. to yesterday in UTC). */
function normaliseDate(value, tz) {
  if (value instanceof Date) return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  var s = String(value == null ? '' : value).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
}

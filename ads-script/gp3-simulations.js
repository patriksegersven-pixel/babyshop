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
  /** Full URL of the target spreadsheet. */
  SPREADSHEET_URL: '',

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
   * nothing even though bidding runs through portfolio strategies.
   */
  INCLUDE_CAMPAIGNS: true,

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
var ROW_SEPARATOR  = '\u00A4';   // currency sign - never appears in Ads data
var CELL_SEPARATOR = '\u001F';   // ASCII unit separator

/* ========================== ENTRY POINTS ========================== */

function main() {
  if (!CONFIG.SPREADSHEET_URL) {
    throw new Error('Set CONFIG.SPREADSHEET_URL before running this script.');
  }
  var runDate = todayInAccountTimezone();
  Logger.log('GP3 simulation collector — run date ' + runDate);

  var accountIds = CONFIG.ACCOUNT_IDS.map(function (id) { return String(id).trim(); })
    .filter(function (id) { return id.length > 0; });
  if (!accountIds.length) throw new Error('CONFIG.ACCOUNT_IDS is empty.');

  var payload = [runDate, CONFIG.INCLUDE_CAMPAIGNS ? '1' : '0', CONFIG.VERBOSE ? '1' : '0']
    .join(ARG_SEPARATOR);

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

  var rows = [];
  try {
    rows = rows.concat(portfolioSimulations(runDate, verbose));
    if (includeCampaigns) rows = rows.concat(campaignSimulations(runDate, verbose));
  } catch (e) {
    Logger.log('ERROR in ' + AdsApp.currentAccount().getName() + ': ' + e);
    return '';
  }
  Logger.log(AdsApp.currentAccount().getName() + ': ' + rows.length + ' simulation point(s).');
  return encodeRows(rows);
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

    var currentTarget = null;
    if (strat.targetRoas && strat.targetRoas.targetRoas != null) {
      currentTarget = strat.targetRoas.targetRoas;
    } else if (strat.maximizeConversionValue && strat.maximizeConversionValue.targetRoas != null) {
      currentTarget = strat.maximizeConversionValue.targetRoas;
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

/** Target ROAS simulations for standalone campaigns (optional). */
function campaignSimulations(runDate, verbose) {
  var customer = accountInfo();
  var out = [];

  var query =
    'SELECT ' +
    '  campaign_simulation.start_date, ' +
    '  campaign_simulation.end_date, ' +
    '  campaign_simulation.type, ' +
    '  campaign_simulation.target_roas_point_list.points, ' +
    '  campaign.id, ' +
    '  campaign.name, ' +
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

    var currentTarget = null;
    if (camp.targetRoas && camp.targetRoas.targetRoas != null) {
      currentTarget = camp.targetRoas.targetRoas;
    } else if (camp.maximizeConversionValue && camp.maximizeConversionValue.targetRoas != null) {
      currentTarget = camp.maximizeConversionValue.targetRoas;
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

/* ========================== ROW BUILDING ========================== */

function accountInfo() {
  var acct = AdsApp.currentAccount();
  return { name: acct.getName(), currency: acct.getCurrencyCode() };
}

/** One spreadsheet row per simulation point, in HEADERS order. */
function buildRow(customer, entity, point, runDate) {
  return [
    customer.name,
    String(entity.name || '').replace(/[,\r\n]+/g, ';'),   // keep the cell on one line
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
  var runDate = todayInAccountTimezone();
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

  var sheet = openSheet();
  ensureHeaders(sheet);
  removeRunDate(sheet, runDate);            // makes a same-day re-run idempotent
  appendRows(sheet, allRows);
  pruneOldRows(sheet, runDate);

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

/** Write the header row if the tab is empty. Never rewrites an existing header. */
function ensureHeaders(sheet) {
  if (sheet.getLastRow() !== 0) return;
  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);
  Logger.log('Bootstrapped header row.');
}

function appendRows(sheet, rows) {
  var startRow = Math.max(sheet.getLastRow(), 1) + 1;
  sheet.getRange(startRow, 1, rows.length, HEADERS.length).setValues(rows);
}

/** Delete rows whose Run Date equals runDate, so today's run replaces itself. */
function removeRunDate(sheet, runDate) {
  deleteRowsWhere(sheet, function (value) { return normaliseDate(value) === runDate; },
    'same-day re-run');
}

/** Delete rows whose Run Date is older than the retention window. */
function pruneOldRows(sheet, runDate) {
  var cutoff = new Date(runDate + 'T00:00:00Z');
  cutoff.setUTCDate(cutoff.getUTCDate() - CONFIG.LOOKBACK_PRUNE_DAYS);
  var cutoffIso = Utilities.formatDate(cutoff, 'UTC', 'yyyy-MM-dd');
  deleteRowsWhere(sheet, function (value) {
    var d = normaliseDate(value);
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

function todayInAccountTimezone() {
  return Utilities.formatDate(new Date(), AdsApp.currentAccount().getTimeZone(), 'yyyy-MM-dd');
}

/** Sheet cells may hold a Date object or a string; compare as yyyy-MM-dd. */
function normaliseDate(value) {
  if (value instanceof Date) return Utilities.formatDate(value, 'UTC', 'yyyy-MM-dd');
  var s = String(value == null ? '' : value).trim();
  var m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? m[0] : '';
}

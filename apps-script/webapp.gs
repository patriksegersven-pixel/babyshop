/**
 * Babyshop — GP3 Optimization
 * Read-only JSON endpoint over the simulation spreadsheet (Google Apps Script)
 * ---------------------------------------------------------------------------
 * Serves the "Raw" tab (written by ads-script/gp3-simulations.js) plus the
 * "Config" tab (optional conversion-value -> GP2 multiplier per account, and the
 * incrementality factors) as a single JSON payload that the static dashboard fetches
 * on load.
 *
 * DATA MODEL
 *   The primary conversion action in these accounts sends cart-level GROSS PROFIT
 *   as its value, so "Conversions Value" in a bid simulation is already GP2 and the
 *   dashboard computes GP3 = GP2 - Cost directly. Revenue lives in a separate
 *   secondary conversion action that bid simulations do not report. No gross margin
 *   is applied anywhere; doing so would deduct cost of goods twice.
 *
 * INCREMENTALITY
 *   Cost is 100% real for every campaign; observed conversion value is not equally
 *   CAUSED by the ad. Brand campaigns only match our own brand queries, and private-label
 *   ("pb") campaigns advertise products sold nowhere else - much of their value would
 *   convert anyway. The Config tab therefore also carries an incrementality factor per
 *   class (brand 0.20, private-label 0.50, generic 1.00) plus optional per-campaign
 *   pattern overrides, served as `config.incrementality`. The dashboard multiplies GP2 by
 *   that factor and reads every recommendation off iGP3 = factor x GP2 - cost. The factors
 *   are ASSUMPTIONS until a geo holdout or conversion-lift test measures them, which is
 *   exactly why they live in a spreadsheet cell and not in code.
 *
 * DEPLOY
 *   1. Open the spreadsheet → Extensions → Apps Script.
 *   2. Paste this file over Code.gs. Save.
 *   3. Set SCRIPT_TOKEN below to a long random string. Generate one with:
 *        node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
 *   4. Run setupConfigTab() once from the editor to create the Config tab and
 *      grant the authorisation prompts. The defaults (multiplier 1.0) are correct
 *      unless an account reports revenue instead of GP2. It also seeds the three
 *      incrementality rows; re-running it later is safe and never overwrites edits.
 *   5. Deploy → New deployment → type "Web app".
 *        Description:   gp3-dashboard-api
 *        Execute as:    Me            (so viewers need no access to the sheet)
 *        Who has access: Anyone with the link
 *      Copy the /exec URL.
 *   6. In index.html set:
 *        const DATA_ENDPOINT = '<the /exec URL>';
 *        const DATA_TOKEN    = '<the same SCRIPT_TOKEN>';
 *   7. Verify in a browser:
 *        <exec-url>?token=<token>&runs=1
 *
 *   After editing this file you must Deploy → Manage deployments → Edit → New
 *   version, otherwise the live URL keeps serving the old code.
 *
 * QUERY PARAMETERS
 *   token    required, must equal SCRIPT_TOKEN
 *   runs     optional, keep only the N most recent Run Dates (e.g. runs=4)
 *   account  optional, exact Customer Name filter
 *
 * SECURITY
 *   The token is a deterrent, not authentication: it travels in a URL that
 *   lives in a public HTML file. Anyone with the link can read the aggregate
 *   simulation data. Keep genuinely sensitive figures out of this sheet.
 */

/* ========================== CONFIG ========================== */

/** Shared secret. Must match DATA_TOKEN in index.html. */
var SCRIPT_TOKEN = 'CHANGE-ME';

/** Tab holding the appended simulation snapshots. */
var RAW_SHEET = 'Raw';

/**
 * Tab holding both config blocks, side by side as two independent column pairs:
 *   A: Account   B: Value to GP2 Multiplier   C: Notes
 *   D: Incrementality Class or Name Pattern   E: Incrementality Factor   F: Notes
 * The pairs are read independently, so a row may fill either, both or neither.
 */
var CONFIG_SHEET = 'Config';

/**
 * Multiplier used for accounts with no Config row. Keep at 1.0: conversion value is
 * already GP2. Only override per account (in the Config tab) for an account whose
 * conversion value is revenue rather than GP2 — then its gross margin is the multiplier.
 */
var DEFAULT_VALUE_TO_GP2_MULTIPLIER = 1.0;

/**
 * Incrementality factor per class, used when the Config tab says nothing.
 * Keep these in sync with INCREMENTALITY_DEFAULTS in index.html — the dashboard carries
 * the same numbers so it still works against an endpoint that predates this block.
 *   brand         0.20  only matches our own brand queries; largely defensive spend
 *   private-label 0.50  own-label products sold nowhere else; much converts anyway
 *   generic       1.00  open-market prospecting; the click is the demand
 */
var DEFAULT_INCREMENTALITY = { brand: 0.20, 'private-label': 0.50, generic: 1.00 };

/**
 * Accepted spellings in the Config tab for each class key (compared after canon(), which
 * strips punctuation and case, so "Private Label" and "private-label" both land here).
 * Deliberately short: anything NOT in this map is treated as a campaign-name pattern, so
 * adding loose aliases here would quietly swallow legitimate overrides.
 */
var INCREMENTALITY_CLASS_ALIASES = {
  brand: 'brand',
  privatelabel: 'private-label',
  generic: 'generic'
};

/** Hard cap on returned rows, newest run dates first. */
var MAX_ROWS = 20000;

/* ========================== ENDPOINT ========================== */

function doGet(e) {
  try {
    var params = (e && e.parameter) || {};

    if (!SCRIPT_TOKEN || SCRIPT_TOKEN === 'CHANGE-ME') {
      return json({ error: 'SCRIPT_TOKEN is not configured in the Apps Script project.' });
    }
    if (params.token !== SCRIPT_TOKEN) {
      return json({ error: 'Unauthorized' });
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var raw = readRaw(ss, params);

    return json({
      generatedAt: new Date().toISOString(),
      source: 'sheet',
      spreadsheet: ss.getName(),
      config: readConfig(ss),
      columns: raw.columns,
      rows: raw.rows,
      rowCount: raw.rows.length,
      runDates: raw.runDates,
      truncated: raw.truncated
    });
  } catch (err) {
    return json({ error: String(err && err.message ? err.message : err) });
  }
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

/* ========================== READERS ========================== */

/**
 * Read the Raw tab as { columns, rows, runDates, truncated }.
 * Rows come back as plain arrays in sheet-column order — compact on the wire,
 * and the dashboard maps them by header name so column order can change safely.
 */
function readRaw(ss, params) {
  var sheet = ss.getSheetByName(RAW_SHEET);
  if (!sheet) throw new Error('Tab "' + RAW_SHEET + '" not found. Has the Ads script run yet?');

  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2 || lastCol < 1) {
    return { columns: [], rows: [], runDates: [], truncated: false };
  }

  var values = sheet.getRange(1, 1, lastRow, lastCol).getDisplayValues();
  var columns = values[0].map(function (h) { return String(h).trim(); });
  var body = values.slice(1);

  var runIdx = indexOfHeader(columns, 'Run Date');
  var acctIdx = indexOfHeader(columns, 'Customer Name');

  // ignore blank filler rows
  body = body.filter(function (r) {
    return r.join('').trim().length > 0;
  });

  if (params.account && acctIdx >= 0) {
    var wanted = String(params.account).trim();
    body = body.filter(function (r) { return String(r[acctIdx]).trim() === wanted; });
  }

  var runDates = [];
  if (runIdx >= 0) {
    var seen = {};
    body.forEach(function (r) {
      var d = normaliseDate(r[runIdx]);
      if (d && !seen[d]) { seen[d] = true; runDates.push(d); }
    });
    runDates.sort();

    var limit = parseInt(params.runs, 10);
    if (limit > 0 && runDates.length > limit) {
      var keep = {};
      runDates.slice(-limit).forEach(function (d) { keep[d] = true; });
      body = body.filter(function (r) { return keep[normaliseDate(r[runIdx])]; });
      runDates = runDates.slice(-limit);
    }
    // normalise the date cells themselves so the client never has to guess a locale
    body.forEach(function (r) { r[runIdx] = normaliseDate(r[runIdx]); });
  }

  var startIdx = indexOfHeader(columns, 'Start Date');
  var endIdx = indexOfHeader(columns, 'End Date');
  body.forEach(function (r) {
    if (startIdx >= 0) r[startIdx] = normaliseDate(r[startIdx]);
    if (endIdx >= 0) r[endIdx] = normaliseDate(r[endIdx]);
  });

  // numeric columns come back from getDisplayValues() as formatted strings
  // ("150%", "392 645 636 289"); hand the client real numbers instead.
  var numericHeaders = ['Current Target Roas', 'TARGET ROAS', 'Conversions', 'Conversions Value',
    'Clicks', 'Cost Micros', 'Impressions', 'Top Slot Impressions'];
  var numericIdx = numericHeaders.map(function (h) { return indexOfHeader(columns, h); })
    .filter(function (i) { return i >= 0; });
  body.forEach(function (r) {
    numericIdx.forEach(function (i) { r[i] = toNumber(r[i]); });
  });

  /* Cap the payload by WHOLE runs, dropping the oldest first, so a partially
     transferred run can never skew a trend point — and so runDates always
     describes exactly the rows returned. */
  var truncated = false;
  if (runIdx >= 0) {
    while (body.length > MAX_ROWS && runDates.length > 1) {
      var dropDate = runDates.shift();
      body = body.filter(function (r) { return r[runIdx] !== dropDate; });
      truncated = true;
    }
  }
  if (body.length > MAX_ROWS) {   // no Run Date column, or a single oversized run
    body = body.slice(-MAX_ROWS);
    truncated = true;
  }

  return { columns: columns, rows: body, runDates: runDates, truncated: truncated };
}

/**
 * Read the Config tab into
 *   {
 *     valueToGp2Multipliers: { account: number },
 *     defaultValueToGp2Multiplier: number,
 *     incrementality: {
 *       classes:   { brand: number, 'private-label': number, generic: number },
 *       overrides: [ { pattern: string, factor: number }, ... ]
 *     }
 *   }
 * Every key is consumed under exactly these names by index.html — keep them in sync.
 *
 * Columns A/B carry the account -> GP2 multiplier pair; columns D/E carry the
 * incrementality pair. A D-cell matching a class name ("brand", "private-label"/"pb",
 * "generic") sets that class's factor; anything else is treated as a CAMPAIGN NAME
 * PATTERN override, matched case-insensitively as a substring of the campaign name, with
 * the longest matching pattern winning. Rows with an empty key or an unparseable factor
 * are skipped, so free-text comment rows in the tab are harmless.
 *
 * An empty or missing Config tab yields multiplier 1.0 and DEFAULT_INCREMENTALITY.
 */
function readConfig(ss) {
  var classes = {};
  Object.keys(DEFAULT_INCREMENTALITY).forEach(function (k) { classes[k] = DEFAULT_INCREMENTALITY[k]; });

  var out = {
    valueToGp2Multipliers: {},
    defaultValueToGp2Multiplier: DEFAULT_VALUE_TO_GP2_MULTIPLIER,
    incrementality: { classes: classes, overrides: [] }
  };
  var sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return out;

  // read at least through column E, but never past the sheet's real width
  var width = Math.min(sheet.getMaxColumns(), Math.max(5, sheet.getLastColumn()));
  var values = sheet.getRange(1, 1, sheet.getLastRow(), width).getDisplayValues();

  for (var i = 1; i < values.length; i++) {
    // --- columns A/B: conversion value -> GP2 multiplier, per account ---
    var name = String(values[i][0] == null ? '' : values[i][0]).trim();
    if (name) {
      var mult = toMultiplier(values[i][1]);
      if (mult !== null) {
        if (name.toLowerCase() === 'default' || name === '*') out.defaultValueToGp2Multiplier = mult;
        else out.valueToGp2Multipliers[name] = mult;
      }
    }

    // --- columns D/E: incrementality class or campaign-name pattern -> factor ---
    var key = String(values[i][3] == null ? '' : values[i][3]).trim();
    if (!key) continue;
    var factor = toFactor(values[i][4]);
    if (factor === null) continue;              // comment row, or an unreadable factor
    var cls = INCREMENTALITY_CLASS_ALIASES[canon(key)];
    if (cls) out.incrementality.classes[cls] = factor;
    else out.incrementality.overrides.push({ pattern: key, factor: factor });
  }
  return out;
}

/* ========================== PARSING HELPERS ========================== */

function indexOfHeader(columns, name) {
  var want = canon(name);
  for (var i = 0; i < columns.length; i++) {
    if (canon(columns[i]) === want) return i;
  }
  return -1;
}

function canon(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** "1 234,5", "1,234.5", "150%" and 1234.5 all become numbers. */
function toNumber(v) {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  var s = String(v == null ? '' : v).trim();
  if (!s) return 0;

  var isPercent = s.indexOf('%') >= 0;
  // The regex \s already covers NBSP (U+00A0) and narrow NBSP (U+202F), which is
  // what Sheets uses as the thousands separator in sv-SE / nb-NO display values.
  s = s.replace(/%/g, '').replace(/\s/g, '');

  // decide which separator is the decimal mark
  var lastComma = s.lastIndexOf(',');
  var lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(',', '.');   // 1.234,5
    else s = s.replace(/,/g, '');                                          // 1,234.5
  } else if (lastComma >= 0) {
    // a lone comma is a decimal mark unless it groups three digits
    s = /,\d{3}(\D|$)/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }

  var n = parseFloat(s);
  if (!isFinite(n)) return 0;
  return isPercent ? n / 100 : n;
}

/**
 * Parse a conversion-value → GP2 multiplier. "1", "1.0" and "100%" all become 1.0;
 * "30", "30%", "0.3" and "0,3" all become 0.30 (an account still reporting revenue).
 * Returns null when unparseable, so the default applies.
 */
function toMultiplier(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return null;
  var n = toNumber(s);
  if (!isFinite(n) || n <= 0) return null;
  if (n > 1) n = n / 100;          // "30" meant 30 per cent, "100" meant 1.0
  return n > 1 ? null : n;
}

/**
 * Parse an incrementality factor. Same forgiving notation as the multiplier — "0.2",
 * "0,2", "20" and "20%" all become 0.20 — but zero is allowed here, meaning "this
 * campaign is assumed to cause none of its reported value". Returns null when the cell
 * is blank or unreadable, so the class default (or a comment row) is left alone.
 */
function toFactor(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return null;
  var n = toNumber(s);
  if (!isFinite(n) || n < 0) return null;
  if (n > 1) n = n / 100;          // "20" meant 20 per cent
  return n > 1 ? null : n;
}

/** Sheet dates may be Date objects or locale strings; emit yyyy-MM-dd. */
function normaliseDate(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'UTC', 'yyyy-MM-dd');
  var s = String(v == null ? '' : v).trim();
  if (!s) return '';

  var iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return iso[1] + '-' + pad(iso[2]) + '-' + pad(iso[3]);

  var slash = s.match(/^(\d{1,4})\/(\d{1,2})\/(\d{1,4})$/);
  if (slash) {
    if (slash[1].length === 4) return slash[1] + '-' + pad(slash[2]) + '-' + pad(slash[3]);
    // Sheets' US display order: M/D/YYYY
    return slash[3] + '-' + pad(slash[1]) + '-' + pad(slash[2]);
  }

  var d = new Date(s);
  return isNaN(d.getTime()) ? s : Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function pad(n) { return ('0' + n).slice(-2); }

/* ========================== ONE-TIME SETUP ========================== */

/**
 * Run once from the Apps Script editor. Creates the Config tab (if missing), pre-fills it
 * with the accounts already present in the Raw tab (each at multiplier 1), and seeds the
 * three incrementality class rows.
 *
 * The A/B pair is an escape hatch, not a required step: it exists only so an account whose
 * conversion value is revenue rather than GP2 can be converted with its gross margin.
 * The D/E pair is different — it is meant to be edited. Idempotent: existing values are
 * never overwritten, so re-running after an upgrade only adds what is missing.
 */
function setupConfigTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet) sheet = ss.insertSheet(CONFIG_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 3)
      .setValues([['Account', 'Value to GP2 Multiplier', 'Notes']])
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1, 1, 3).setValues([
      ['Default', '1', 'Conversion value is already GP2 — leave at 1 unless an account reports revenue']
    ]);
  }

  var known = {};
  var lastRow = sheet.getLastRow();
  if (lastRow > 1) {
    sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues()
      .forEach(function (r) { known[String(r[0]).trim()] = true; });
  }

  var raw = ss.getSheetByName(RAW_SHEET);
  if (raw && raw.getLastRow() > 1) {
    var cols = raw.getRange(1, 1, 1, raw.getLastColumn()).getDisplayValues()[0];
    var idx = indexOfHeader(cols, 'Customer Name');
    if (idx >= 0) {
      var seen = {}, toAdd = [];
      raw.getRange(2, idx + 1, raw.getLastRow() - 1, 1).getDisplayValues().forEach(function (r) {
        var name = String(r[0]).trim();
        if (name && !seen[name] && !known[name]) { seen[name] = true; toAdd.push([name, '1', '']); }
      });
      if (toAdd.length) {
        sheet.getRange(sheet.getLastRow() + 1, 1, toAdd.length, 3).setValues(toAdd);
        Logger.log('Added ' + toAdd.length + ' account row(s) to Config.');
      }
    }
  }

  seedIncrementalityRows(sheet);

  Logger.log('Config tab ready. Leave every multiplier at 1 unless an account reports ' +
    'revenue instead of GP2 as its conversion value; then set that account\'s gross margin. ' +
    'Incrementality factors live in columns D/E and ARE meant to be edited — they are ' +
    'assumptions until a geo holdout or conversion-lift test measures them. ' +
    'Deploy the web app afterwards.');
}

/**
 * Seed columns D–F of the Config tab: one row per incrementality class plus a comment row
 * documenting per-campaign overrides. Done as a separate column pair rather than a section
 * in column A so a class name can never collide with an account name, and so the two
 * blocks can be edited independently. Never touches a cell that already has a value.
 */
function seedIncrementalityRows(sheet) {
  if (sheet.getMaxColumns() < 6) sheet.insertColumnsAfter(sheet.getMaxColumns(), 6 - sheet.getMaxColumns());

  if (!String(sheet.getRange(1, 4).getDisplayValue()).trim()) {
    sheet.getRange(1, 4, 1, 3)
      .setValues([['Incrementality Class or Name Pattern', 'Incrementality Factor', 'Notes']])
      .setFontWeight('bold');
  }

  var lastRow = sheet.getLastRow();
  var hasAny = false;
  if (lastRow > 1) {
    sheet.getRange(2, 4, lastRow - 1, 1).getDisplayValues().forEach(function (r) {
      if (String(r[0]).trim()) hasAny = true;
    });
  }
  if (hasAny) return;   // already configured — leave the operator's numbers alone

  var seed = [
    ['brand', '0.20',
      'Brand campaigns only match babyshop/lekmer brand queries. That demand already chose us and mostly ' +
      'arrives anyway, so only ~20% of the reported value is assumed to be caused by the ad. Cost is 100% real. ' +
      'Note the spend is also defensive (competitors bid on our brand terms), so a low factor does NOT mean minimise.'],
    ['private-label', '0.50',
      'Private-label ("pb") campaigns advertise products sold nowhere else — the shopper who wants one has a ' +
      'single place to buy it, so roughly half the value is assumed to convert without the ad.'],
    ['generic', '1.00',
      'Open-market prospecting: the click is the demand, so value is taken at face value. Leave at 1.00.'],
    ['', '',
      'OVERRIDES: put a campaign-name pattern (not a class) in column D with its own factor in column E to ' +
      'override that campaign\'s class factor — e.g. "p-shopping-se-pb-product" with 0.65. Matching is ' +
      'case-insensitive substring; when several patterns match a name, the LONGEST one wins. ' +
      'All of these are assumptions: replace them with geo-holdout or conversion-lift measurements when you have them.']
  ];

  var needRows = 1 + seed.length;
  if (sheet.getMaxRows() < needRows) sheet.insertRowsAfter(sheet.getMaxRows(), needRows - sheet.getMaxRows());
  sheet.getRange(2, 4, seed.length, 3).setValues(seed);
  Logger.log('Seeded incrementality defaults: brand 0.20, private-label 0.50, generic 1.00.');
}

/** Sanity-check the payload from the editor without deploying. */
function testPayload() {
  var out = doGet({ parameter: { token: SCRIPT_TOKEN, runs: '1' } });
  var parsed = JSON.parse(out.getContent());
  Logger.log('error:      ' + (parsed.error || 'none'));
  Logger.log('rows:       ' + parsed.rowCount);
  Logger.log('runDates:   ' + JSON.stringify(parsed.runDates));
  Logger.log('columns:    ' + JSON.stringify(parsed.columns));
  Logger.log('config:     ' + JSON.stringify(parsed.config));
  Logger.log('first row:  ' + JSON.stringify(parsed.rows[0]));
}

/**
 * Babyshop — GP3 Optimization
 * Read-only JSON endpoint over the simulation spreadsheet (Google Apps Script)
 * ---------------------------------------------------------------------------
 * Serves the "Raw" tab (written by ads-script/gp3-simulations.js) plus the
 * "Config" tab (gross margin per account) as a single JSON payload that the
 * static dashboard fetches on load.
 *
 * DEPLOY
 *   1. Open the spreadsheet → Extensions → Apps Script.
 *   2. Paste this file over Code.gs. Save.
 *   3. Set SCRIPT_TOKEN below to a long random string. Generate one with:
 *        node -e "console.log(require('crypto').randomBytes(24).toString('hex'))"
 *   4. Run setupConfigTab() once from the editor to create the Config tab and
 *      grant the authorisation prompts.
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

/** Tab mapping account name → gross margin. */
var CONFIG_SHEET = 'Config';

/** Gross margin used for accounts with no Config row. */
var DEFAULT_MARGIN = 0.30;

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

  var truncated = false;
  if (body.length > MAX_ROWS) {
    body = body.slice(-MAX_ROWS);   // keep the newest, they sit at the bottom
    truncated = true;
  }

  return { columns: columns, rows: body, runDates: runDates, truncated: truncated };
}

/** Read the Config tab into { margins: {account: fraction}, defaultMargin }. */
function readConfig(ss) {
  var out = { margins: {}, defaultMargin: DEFAULT_MARGIN };
  var sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet || sheet.getLastRow() < 2) return out;

  var values = sheet.getRange(1, 1, sheet.getLastRow(), Math.max(2, sheet.getLastColumn()))
    .getDisplayValues();

  for (var i = 1; i < values.length; i++) {
    var name = String(values[i][0]).trim();
    var raw = values[i][1];
    if (!name) continue;
    var margin = toMargin(raw);
    if (margin === null) continue;
    if (name.toLowerCase() === 'default' || name === '*') out.defaultMargin = margin;
    else out.margins[name] = margin;
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

/** "30", "30%", "0.3" and "0,3" all become 0.30. Returns null when unparseable. */
function toMargin(v) {
  var s = String(v == null ? '' : v).trim();
  if (!s) return null;
  var n = toNumber(s);
  if (!isFinite(n) || n <= 0) return null;
  if (n > 1) n = n / 100;          // "30" meant 30 per cent
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
 * Run once from the Apps Script editor. Creates the Config tab (if missing) and
 * pre-fills it with the accounts already present in the Raw tab.
 */
function setupConfigTab() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(CONFIG_SHEET);
  if (!sheet) sheet = ss.insertSheet(CONFIG_SHEET);

  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, 3)
      .setValues([['Account', 'Gross Margin %', 'Notes']])
      .setFontWeight('bold');
    sheet.setFrozenRows(1);
    sheet.getRange(2, 1, 1, 3).setValues([
      ['Default', '30%', 'Applied to any account without its own row below']
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
        if (name && !seen[name] && !known[name]) { seen[name] = true; toAdd.push([name, '30%', '']); }
      });
      if (toAdd.length) {
        sheet.getRange(sheet.getLastRow() + 1, 1, toAdd.length, 3).setValues(toAdd);
        Logger.log('Added ' + toAdd.length + ' account row(s) to Config.');
      }
    }
  }
  Logger.log('Config tab ready. Edit the margins, then deploy the web app.');
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

// Paste this whole file into: your Google Sheet -> Extensions -> Apps Script
// (replacing whatever placeholder code is already there), then Deploy ->
// New deployment -> type "Web app" -> Execute as "Me" -> Who has access
// "Anyone" -> Deploy. Copy the Web app URL it gives you and set it as
// GOOGLE_SHEETS_WEBHOOK_URL in the dashboard server's backend/.env.
//
// "Anyone" here just means "anyone who has this exact URL can POST to it" -
// it does not make your spreadsheet itself public, and the URL is never
// shown anywhere except to you and inside your own server's .env file.
//
// The MMPL dashboard backend POSTs a JSON summary here once a week
// (scripts/sync-sheets.js, via cron). This script writes it into two tabs:
// "Summary" (totals by stage/category/FY) and "All Certificates" (one row
// per certificate). Both tabs are fully overwritten each run, so the sheet
// always reflects the latest snapshot rather than growing a new block of
// rows every week.

function doPost(e) {
  var payload = JSON.parse(e.postData.contents);
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var summary = ss.getSheetByName('Summary') || ss.insertSheet('Summary');
  summary.clear();
  summary.appendRow(['MMPL Dashboard - Weekly Summary']);
  summary.appendRow(['Generated', payload.generatedAt]);
  summary.appendRow(['Total certificates', payload.totalCertificates]);
  summary.appendRow([]);

  summary.appendRow(['By stage', 'Count', 'Total amount']);
  (payload.byStage || []).forEach(function (r) {
    summary.appendRow([r.stage, r.count, r.amount]);
  });
  summary.appendRow([]);

  summary.appendRow(['By category', 'Count', 'Total amount']);
  (payload.byCategory || []).forEach(function (r) {
    summary.appendRow([r.category, r.count, r.amount]);
  });
  summary.appendRow([]);

  summary.appendRow(['By financial year', 'Count', 'Total amount']);
  (payload.byFy || []).forEach(function (r) {
    summary.appendRow([r.fy, r.count, r.amount]);
  });

  var raw = ss.getSheetByName('All Certificates') || ss.insertSheet('All Certificates');
  raw.clear();
  raw.appendRow(['ID', 'Stage', 'Category', 'Client', 'Owner', 'FY', 'Tender No', 'Amount', 'Target Date', 'Bill No', 'Bill Date']);
  (payload.rows || []).forEach(function (r) {
    raw.appendRow([r.id, r.stage, r.category, r.client, r.owner, r.fy, r.tender_no, r.amount, r.target_date, r.bill_no, r.bill_date]);
  });

  return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
}

// Lets you open the Web app URL directly in a browser to sanity-check it's
// live (it'll just say "MMPL Sheets webhook is live" rather than write
// anything - only a POST from the dashboard actually updates the sheet).
function doGet(e) {
  return ContentService.createTextOutput('MMPL Sheets webhook is live. Waiting for the weekly POST from the dashboard.');
}

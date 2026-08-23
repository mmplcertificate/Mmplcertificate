// Weekly Google Sheets summary - optional, off by default. Posts a JSON
// snapshot of the certificates table to a Google Apps Script "Web app" URL
// that Akash sets up himself (see deploy/google-apps-script.js for the
// script he pastes in, and ec2-bootstrap.sh's final output for the setup
// steps). Deliberately NOT using a Google Cloud service account + Sheets
// API - that would mean a GCP project, enabling the Sheets API, and a
// downloaded credentials JSON living on the server. A pasted Apps Script
// web app is genuinely free forever, has no quota to worry about, and the
// only secret involved is a URL, which is far lower-stakes than a service
// account key if it ever leaked.
//
// Every exported function is designed to NEVER throw: a missing/unreachable
// webhook must never break anything else, same pattern as notify.js.
async function pushWeeklySummary(payload) {
  const url = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  if (!url) {
    console.log('[sheets-sync] GOOGLE_SHEETS_WEBHOOK_URL not set - skipping weekly Sheets push.');
    return;
  }
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow', // Apps Script web app URLs 302-redirect once before responding.
    });
    if (!res.ok) {
      console.error(`[sheets-sync] Sheets webhook responded ${res.status}: ${(await res.text()).slice(0, 300)}`);
      return;
    }
    console.log('[sheets-sync] Weekly summary pushed to Google Sheets.');
  } catch (e) {
    console.error('[sheets-sync] Failed to push weekly summary:', e.message);
  }
}

// Builds the payload from the certificates table. Kept separate from the
// push itself so scripts/sync-sheets.js's DB query logic is easy to read
// and test independently of the network call.
function buildSummary(db) {
  const rows = db
    .prepare(
      `SELECT id, stage, category, client, owner, fy, tender_no, amount, target_date, bill_no, bill_date
       FROM certificates ORDER BY fy DESC, id DESC`
    )
    .all();

  const groupBy = (key) => {
    const map = new Map();
    for (const r of rows) {
      const k = r[key] || '(none)';
      const entry = map.get(k) || { count: 0, amount: 0 };
      entry.count += 1;
      entry.amount += r.amount || 0;
      map.set(k, entry);
    }
    return Array.from(map.entries()).map(([k, v]) => ({ [key]: k, count: v.count, amount: v.amount }));
  };

  return {
    generatedAt: new Date().toISOString(),
    totalCertificates: rows.length,
    byStage: groupBy('stage'),
    byCategory: groupBy('category'),
    byFy: groupBy('fy'),
    rows,
  };
}

module.exports = { pushWeeklySummary, buildSummary };

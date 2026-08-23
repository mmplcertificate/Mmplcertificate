#!/usr/bin/env node
// One-time migration: pushes your real certificate tracker data (139 records)
// and a set of real signed/draft certificate documents into the live Render
// trial, using the app's own HTTP API - nothing else needed, no server shell
// access required (Render's free tier doesn't offer that anyway).
//
// HOW TO RUN (in Git Bash, from anywhere):
//   ADMIN_PASSWORD="your-real-admin-password" node migrate-real-data.js
//
// Your password only ever goes from your own machine straight to
// mmplcertificate.onrender.com - it is not written anywhere in this file and
// is never seen by anyone else.
//
// What this does:
//  1. Migrates all 139 certificate records from certificates_data.json
//     (tracker/billing data only - no documents) so the trial's dashboard
//     is fully populated.
//  2. Creates 32 extra certificate records, one per real past engagement,
//     each with its actual real signed (or draft) certificate document
//     attached - these are what Gemini will match against and draft from
//     when you submit a test NIT.
//  3. Adds 4 blank master templates (from "Certificate Templates") as a
//     fallback for categories that don't have a real example above.
//
// This is a ONE-TIME script for the temporary Render trial. Real production
// migration (with persistent storage) will happen properly once AWS is live.

const fs = require('fs');
const path = require('path');

const BASE = process.env.MMPL_BASE_URL || 'https://mmplcertificate.onrender.com';
const MMPL_ROOT = 'C:\\Users\\USER\\Desktop\\MMPL\\Certificates 25-26';
const DATA_JSON = path.join(MMPL_ROOT, 'Dashboard and Automation Tool', 'certificates_data.json');
const TEMPLATES_DIR = path.join(MMPL_ROOT, 'Certificate Templates');

// Real signed/draft certificates, hand-filtered from the 44 real engagement
// folders to exclude anything that was mis-tagged as a certificate but is
// actually an email/letter (verified by filename), and to exclude anything
// too ambiguous to confidently categorize.
const PICKS = [{"engagement": "07.05.2026 Shergaon and Harpalpur SH and NW Certificate (Harpalpur)", "file": "MMPL AK/07.05.2026 Shergaon and Harpalpur SH and NW Certificate/Signed Certificates/Net Worth Certificate- Harpalpur.pdf", "category": "Net Worth Certificate"}, {"engagement": "07.05.2026 Shergaon and Harpalpur SH and NW Certificate (Shergaon)", "file": "MMPL AK/07.05.2026 Shergaon and Harpalpur SH and NW Certificate/Signed Certificates/Net Worth Certificate-Shergaon.pdf", "category": "Net Worth Certificate"}, {"engagement": "07.05.2026 Shergaon and Harpalpur SH and NW Certificate (Harpalpur)", "file": "MMPL AK/07.05.2026 Shergaon and Harpalpur SH and NW Certificate/Signed Certificates/Shareholder Certificate-Harpalpur.pdf", "category": "Shareholding Certificate"}, {"engagement": "07.05.2026 Shergaon and Harpalpur SH and NW Certificate (Shergaon)", "file": "MMPL AK/07.05.2026 Shergaon and Harpalpur SH and NW Certificate/Signed Certificates/Shareholding Certificate-Shergaon Block.pdf", "category": "Shareholding Certificate"}, {"engagement": "10.03.2026 SHCM Kumaridh", "file": "MMPL AK/10.03.2026 SHCM Kumaridh/Local Content/Local Content Certificate.pdf", "category": "Local Content Certificate"}, {"engagement": "10.03.2026 SHCM Kumaridh", "file": "MMPL AK/10.03.2026 SHCM Kumaridh/Turnover Certificate/Turnover Certificate.pdf", "category": "Turnover Certificate"}, {"engagement": "10.03.2026 SHCM Kumaridh", "file": "MMPL AK/10.03.2026 SHCM Kumaridh/Working Capital Certificate/Working Capital certificate.pdf", "category": "Working Capital Certificate"}, {"engagement": "14.04.2026 Solvency Certificate AEO Program", "file": "MMPL AK/14.04.2026 Solvency Certificate AEO Program/Solvency certificate.pdf", "category": "Solvency Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Amdabera)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/Networth certificate amdabera.pdf", "category": "Net Worth Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Khandap)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/Networth certificate khandap.pdf", "category": "Net Worth Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Mushanal)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/Networth certificate Mushanal.pdf", "category": "Net Worth Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Amdabera)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/shareholding certificate amdabera .pdf", "category": "Shareholding Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Khandap)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/Shareholding certificate Khandap.pdf", "category": "Shareholding Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Mushanal)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/Shareholding certificate Mushanal.pdf", "category": "Shareholding Certificate"}, {"engagement": "16.02.2026 Mineral Exploration Andhra Pradesh", "file": "MMPL AK/16.02.2026 Mineral Exploration Andhra Pradesh/Signed/Networth.pdf", "category": "Net Worth Certificate"}, {"engagement": "16.02.2026 Mineral Exploration Andhra Pradesh", "file": "MMPL AK/16.02.2026 Mineral Exploration Andhra Pradesh/Signed/Turnover.pdf", "category": "Turnover Certificate"}, {"engagement": "19.02.2026 HCL CDR certificate and Production shaft (CDR)", "file": "MMPL AK/19.02.2026 HCL CDR certificate and Production shaft/CDR/CDR_HCL_19.02.2026.pdf", "category": "CDR Certificate"}, {"engagement": "19.02.2026 HCL CDR certificate and Production shaft (Production Shaft)", "file": "MMPL AK/19.02.2026 HCL CDR certificate and Production shaft/Production Shaft/CDR_PS_HCL_19.02.2026.pdf", "category": "CDR Certificate"}, {"engagement": "21.03.2026 Gmet_Net Worh", "file": "MMPL AK/21.03.2026 Gmet_Net Worh/Net Worth Certificate Signed GMET.pdf", "category": "Net Worth Certificate"}, {"engagement": "21.05.2026 Khetri T.w and NO CDR", "file": "MMPL AK/21.05.2026 Khetri T.w and NO CDR/NO CDR Certificate_Khetri.pdf", "category": "No CDR Certificate"}, {"engagement": "21.05.2026 Khetri T.w and NO CDR", "file": "MMPL AK/21.05.2026 Khetri T.w and NO CDR/Turnover Certificate_Khetri.pdf", "category": "Turnover Certificate"}, {"engagement": "26.02.2026 Share holding certificate GOI MOM", "file": "MMPL AK/26.02.2026 Share holding certificate GOI MOM/Signed Shareholding Certificate.pdf", "category": "Shareholding Certificate"}, {"engagement": "27.05.2026 NLC NW and T.O Certificate", "file": "MMPL AK/27.05.2026 NLC NW and T.O Certificate/Signed certificates/Net Worth Certificate_001.pdf", "category": "Net Worth Certificate"}, {"engagement": "27.05.2026 NLC NW and T.O Certificate", "file": "MMPL AK/27.05.2026 NLC NW and T.O Certificate/Signed certificates/Turnover Certificate_001.pdf", "category": "Turnover Certificate"}, {"engagement": "29.05.2026 Damodar valley 6 Certificates", "file": "MMPL AK/29.05.2026 Damodar valley 6 Certificates/Signed certificates/Local Content Certificate_001.pdf", "category": "Local Content Certificate"}, {"engagement": "29.05.2026 Damodar valley 6 Certificates", "file": "MMPL AK/29.05.2026 Damodar valley 6 Certificates/Signed certificates/Net Worth Certificate_001.pdf", "category": "Net Worth Certificate"}, {"engagement": "29.05.2026 Damodar valley 6 Certificates", "file": "MMPL AK/29.05.2026 Damodar valley 6 Certificates/Signed certificates/No CDR Certificate_001.pdf", "category": "No CDR Certificate"}, {"engagement": "29.05.2026 Damodar valley 6 Certificates", "file": "MMPL AK/29.05.2026 Damodar valley 6 Certificates/Signed certificates/Turnover Certificate_001.pdf", "category": "Turnover Certificate"}, {"engagement": "29.05.2026 Damodar valley 6 Certificates", "file": "MMPL AK/29.05.2026 Damodar valley 6 Certificates/Signed certificates/Working Capital Certificate_001.pdf", "category": "Working Capital Certificate"}, {"engagement": "30.05.2026 MOIL-ukwa", "file": "MMPL AK/30.05.2026 MOIL-ukwa/MOIL-ukwa/signed certificate Local Content Certificate MOIL .pdf", "category": "Local Content Certificate"}, {"engagement": "GMDC Ambaji Core Drilling Tender (New folder)", "file": "New folder/Signed Certificate Turnover and PL.pdf", "category": "Turnover Certificate"}, {"engagement": "ECL Winder Local Content (New folder (2))", "file": "New folder (2)/ECL_Local_Content_Certificate_MMPL_1.docx", "category": "Local Content Certificate"}];

const BLANK_TEMPLATES = [
  ['CDR Certificate.docx', 'CDR Certificate'],
  ['Local Content certificate.docx', 'Local Content Certificate'],
  ['Net Worth.docx', 'Net Worth Certificate'],
  ['Turnover Certificate.docx', 'Turnover Certificate'],
];

function getSessionCookieFromResponse(res) {
  let cookies = [];
  if (typeof res.headers.getSetCookie === 'function') {
    cookies = res.headers.getSetCookie();
  } else {
    const single = res.headers.get('set-cookie');
    if (single) cookies = [single];
  }
  const raw = cookies.find((c) => c && c.startsWith('mmpl_session='));
  if (!raw) return null;
  return raw.split(';')[0];
}

async function login() {
  const password = process.env.ADMIN_PASSWORD;
  if (!password) {
    console.error('Set ADMIN_PASSWORD in your shell first, e.g.:');
    console.error('  ADMIN_PASSWORD="your-real-password" node migrate-real-data.js');
    process.exit(1);
  }
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password }),
  });
  if (!res.ok) {
    console.error('Login failed:', res.status, await res.text());
    process.exit(1);
  }
  const cookie = getSessionCookieFromResponse(res);
  if (!cookie) {
    console.error('Login succeeded but no session cookie came back - aborting.');
    process.exit(1);
  }
  return cookie;
}

async function createCertificate(cookie, body) {
  const res = await fetch(`${BASE}/api/certificates`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`create cert failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function attachDocument(cookie, certId, filePath, displayName) {
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer]), displayName);
  form.append('doc_type', 'certificate');
  form.append('display_name', displayName);
  const res = await fetch(`${BASE}/api/certificates/${certId}/documents`, {
    method: 'POST',
    headers: { Cookie: cookie },
    body: form,
  });
  if (!res.ok) throw new Error(`attach doc failed: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  console.log('Logging in as admin...');
  const cookie = await login();
  console.log('Logged in.\n');

  // --- Part 1: full certificate metadata (139 records) ---
  const raw = JSON.parse(fs.readFileSync(DATA_JSON, 'utf8'));
  const certs = raw.certificates || [];
  console.log(`Part 1: migrating ${certs.length} certificate records (metadata only)...`);
  let n = 0;
  let failed1 = 0;
  for (const c of certs) {
    try {
      await createCertificate(cookie, {
        stage: c.stage || 'in_progress',
        category: c.category,
        client: c.client,
        owner: c.owner,
        tender_no: c.tender_no,
        fy: c.fy,
        particulars: c.particulars,
        document_date: c.document_date,
        signing_date: c.signing_date,
        target_date: c.target_date,
        amount: c.amount,
        udin: c.udin,
        bill_no: c.bill_no,
        bill_date: c.bill_date,
        notes: c.notes,
      });
      n += 1;
      if (n % 20 === 0) console.log(`  ${n}/${certs.length}`);
    } catch (e) {
      failed1 += 1;
      console.warn(`  FAILED on "${c.particulars || c.id}": ${e.message}`);
    }
  }
  console.log(`Part 1 done: ${n} migrated, ${failed1} failed.\n`);

  // --- Part 2: real signed/draft certificates as drafting templates ---
  console.log(`Part 2: attaching ${PICKS.length} real template documents...`);
  let m = 0;
  let failed2 = 0;
  for (const p of PICKS) {
    const filePath = path.join(MMPL_ROOT, p.file.replace(/\//g, path.sep));
    if (!fs.existsSync(filePath)) {
      console.warn(`  MISSING, skipping: ${filePath}`);
      failed2 += 1;
      continue;
    }
    try {
      const cert = await createCertificate(cookie, {
        stage: 'billed',
        category: p.category,
        client: 'MMPL Private Limited',
        particulars: p.engagement,
        notes: `Real template migrated for Gemini drafting testing (source engagement: ${p.engagement})`,
      });
      await attachDocument(cookie, cert.id, filePath, path.basename(filePath));
      m += 1;
      console.log(`  [${m}/${PICKS.length}] ${p.category} <- ${p.engagement}`);
    } catch (e) {
      failed2 += 1;
      console.warn(`  FAILED on "${p.engagement}": ${e.message}`);
    }
  }
  console.log(`Part 2 done: ${m} attached, ${failed2} failed/missing.\n`);

  // --- Part 3: blank master templates as a category fallback ---
  console.log('Part 3: attaching blank master templates...');
  let k = 0;
  for (const [fname, cat] of BLANK_TEMPLATES) {
    const filePath = path.join(TEMPLATES_DIR, fname);
    if (!fs.existsSync(filePath)) {
      console.warn(`  MISSING, skipping: ${filePath}`);
      continue;
    }
    try {
      const cert = await createCertificate(cookie, {
        stage: 'billed',
        category: cat,
        client: 'MMPL Private Limited',
        particulars: `Master blank template - ${cat}`,
        notes: 'Blank master template migrated for Gemini drafting testing.',
      });
      await attachDocument(cookie, cert.id, filePath, fname);
      k += 1;
      console.log(`  attached: ${cat}`);
    } catch (e) {
      console.warn(`  FAILED on "${cat}": ${e.message}`);
    }
  }
  console.log(`Part 3 done: ${k} blank templates attached.\n`);

  console.log('All done. Log into the dashboard and check the certificates list.');
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});

#!/usr/bin/env python3
# One-time migration: pushes your real certificate tracker data (139 records)
# and a set of real signed/draft certificate documents into the live Render
# trial, using the app's own HTTP API - nothing else needed, no server shell
# access required (Render's free tier doesn't offer that anyway).
#
# HOW TO RUN (in Git Bash, from anywhere):
#   ADMIN_PASSWORD="your-real-admin-password" python migrate_real_data.py
#
# Your password only ever goes from your own machine straight to
# mmplcertificate.onrender.com - it is not written anywhere in this file and
# is never seen by anyone else.
#
# What this does:
#  1. Migrates all 139 certificate records from certificates_data.json
#     (tracker/billing data only - no documents) so the trial's dashboard
#     is fully populated.
#  2. Creates 32 extra certificate records, one per real past engagement,
#     each with its actual real signed (or draft) certificate document
#     attached - these are what Gemini will match against and draft from
#     when you submit a test NIT.
#  3. Adds 4 blank master templates (from "Certificate Templates") as a
#     fallback for categories that don't have a real example above.
#
# Safe to re-run: before creating anything, it fetches what's already on the
# server and skips any (category, particulars) pair that already exists, so
# running this twice in a row (e.g. because a Render redeploy did NOT wipe
# the free-tier DB in between, which can happen) will not create duplicate
# certificates. If you deliberately want a full fresh copy, wipe the DB
# first (any push triggers a Render redeploy, which normally does this)
# before re-running.
#
# This is a ONE-TIME script for the temporary Render trial. Real production
# migration (with persistent storage) will happen properly once AWS is live.

import json
import os
import sys
from pathlib import Path

import requests

BASE = os.environ.get("MMPL_BASE_URL", "https://mmplcertificate.onrender.com")
MMPL_ROOT = Path(r"C:\Users\USER\Desktop\MMPL\Certificates 25-26")
DATA_JSON = MMPL_ROOT / "Dashboard and Automation Tool" / "certificates_data.json"
TEMPLATES_DIR = MMPL_ROOT / "Certificate Templates"

# Real signed/draft certificates, hand-picked from the real MMPL AK folders
# (walked folder-by-folder, not from the stale per-engagement auto-tags) to
# exclude anything that was mail/letter correspondence rather than the actual
# certificate, and to exclude anything too ambiguous to confidently categorize.
PICKS = json.loads(r"""[{"engagement": "07.05.2026 Shergaon and Harpalpur SH and NW Certificate (Harpalpur)", "file": "MMPL AK/07.05.2026 Shergaon and Harpalpur SH and NW Certificate/Signed Certificates/Net Worth Certificate- Harpalpur.pdf", "category": "Net Worth Certificate"}, {"engagement": "07.05.2026 Shergaon and Harpalpur SH and NW Certificate (Shergaon)", "file": "MMPL AK/07.05.2026 Shergaon and Harpalpur SH and NW Certificate/Signed Certificates/Net Worth Certificate-Shergaon.pdf", "category": "Net Worth Certificate"}, {"engagement": "07.05.2026 Shergaon and Harpalpur SH and NW Certificate (Harpalpur)", "file": "MMPL AK/07.05.2026 Shergaon and Harpalpur SH and NW Certificate/Signed Certificates/Shareholder Certificate-Harpalpur.pdf", "category": "Shareholding Certificate"}, {"engagement": "07.05.2026 Shergaon and Harpalpur SH and NW Certificate (Shergaon)", "file": "MMPL AK/07.05.2026 Shergaon and Harpalpur SH and NW Certificate/Signed Certificates/Shareholding Certificate-Shergaon Block.pdf", "category": "Shareholding Certificate"}, {"engagement": "10.03.2026 SHCM Kumaridh", "file": "MMPL AK/10.03.2026 SHCM Kumaridh/Local Content/Local Content Certificate.pdf", "category": "Local Content Certificate"}, {"engagement": "10.03.2026 SHCM Kumaridh", "file": "MMPL AK/10.03.2026 SHCM Kumaridh/Turnover Certificate/Turnover Certificate.pdf", "category": "Turnover Certificate"}, {"engagement": "10.03.2026 SHCM Kumaridh", "file": "MMPL AK/10.03.2026 SHCM Kumaridh/Working Capital Certificate/Working Capital certificate.pdf", "category": "Working Capital Certificate"}, {"engagement": "14.04.2026 Solvency Certificate AEO Program", "file": "MMPL AK/14.04.2026 Solvency Certificate AEO Program/Solvency certificate.pdf", "category": "Solvency Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Amdabera)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/Networth certificate amdabera.pdf", "category": "Net Worth Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Khandap)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/Networth certificate khandap.pdf", "category": "Net Worth Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Mushanal)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/Networth certificate Mushanal.pdf", "category": "Net Worth Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Amdabera)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/shareholding certificate amdabera .pdf", "category": "Shareholding Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Khandap)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/Shareholding certificate Khandap.pdf", "category": "Shareholding Certificate"}, {"engagement": "14.05.2026 3 tender nw and Sh certificate (Mushanal)", "file": "MMPL AK/14.05.2026 3 tender nw and Sh certificate/MMPL Final certificates/Shareholding certificate Mushanal.pdf", "category": "Shareholding Certificate"}, {"engagement": "16.02.2026 Mineral Exploration Andhra Pradesh", "file": "MMPL AK/16.02.2026 Mineral Exploration Andhra Pradesh/Signed/Networth.pdf", "category": "Net Worth Certificate"}, {"engagement": "16.02.2026 Mineral Exploration Andhra Pradesh", "file": "MMPL AK/16.02.2026 Mineral Exploration Andhra Pradesh/Signed/Turnover.pdf", "category": "Turnover Certificate"}, {"engagement": "19.02.2026 HCL CDR certificate and Production shaft (CDR)", "file": "MMPL AK/19.02.2026 HCL CDR certificate and Production shaft/CDR/CDR_HCL_19.02.2026.pdf", "category": "CDR Certificate"}, {"engagement": "19.02.2026 HCL CDR certificate and Production shaft (Production Shaft)", "file": "MMPL AK/19.02.2026 HCL CDR certificate and Production shaft/Production Shaft/CDR_PS_HCL_19.02.2026.pdf", "category": "CDR Certificate"}, {"engagement": "21.03.2026 Gmet_Net Worh", "file": "MMPL AK/21.03.2026 Gmet_Net Worh/Net Worth Certificate Signed GMET.pdf", "category": "Net Worth Certificate"}, {"engagement": "21.05.2026 Khetri T.w and NO CDR", "file": "MMPL AK/21.05.2026 Khetri T.w and NO CDR/NO CDR Certificate_Khetri.pdf", "category": "No CDR Certificate"}, {"engagement": "21.05.2026 Khetri T.w and NO CDR", "file": "MMPL AK/21.05.2026 Khetri T.w and NO CDR/Turnover Certificate_Khetri.pdf", "category": "Turnover Certificate"}, {"engagement": "26.02.2026 Share holding certificate GOI MOM", "file": "MMPL AK/26.02.2026 Share holding certificate GOI MOM/Signed Shareholding Certificate.pdf", "category": "Shareholding Certificate"}, {"engagement": "27.05.2026 NLC NW and T.O Certificate", "file": "MMPL AK/27.05.2026 NLC NW and T.O Certificate/Signed certificates/Net Worth Certificate_001.pdf", "category": "Net Worth Certificate"}, {"engagement": "27.05.2026 NLC NW and T.O Certificate", "file": "MMPL AK/27.05.2026 NLC NW and T.O Certificate/Signed certificates/Turnover Certificate_001.pdf", "category": "Turnover Certificate"}, {"engagement": "29.05.2026 Damodar valley 6 Certificates", "file": "MMPL AK/29.05.2026 Damodar valley 6 Certificates/Signed certificates/Local Content Certificate_001.pdf", "category": "Local Content Certificate"}, {"engagement": "29.05.2026 Damodar valley 6 Certificates", "file": "MMPL AK/29.05.2026 Damodar valley 6 Certificates/Signed certificates/Net Worth Certificate_001.pdf", "category": "Net Worth Certificate"}, {"engagement": "29.05.2026 Damodar valley 6 Certificates", "file": "MMPL AK/29.05.2026 Damodar valley 6 Certificates/Signed certificates/No CDR Certificate_001.pdf", "category": "No CDR Certificate"}, {"engagement": "29.05.2026 Damodar valley 6 Certificates", "file": "MMPL AK/29.05.2026 Damodar valley 6 Certificates/Signed certificates/Turnover Certificate_001.pdf", "category": "Turnover Certificate"}, {"engagement": "29.05.2026 Damodar valley 6 Certificates", "file": "MMPL AK/29.05.2026 Damodar valley 6 Certificates/Signed certificates/Working Capital Certificate_001.pdf", "category": "Working Capital Certificate"}, {"engagement": "30.05.2026 MOIL-ukwa", "file": "MMPL AK/30.05.2026 MOIL-ukwa/MOIL-ukwa/signed certificate Local Content Certificate MOIL .pdf", "category": "Local Content Certificate"}, {"engagement": "GMDC Ambaji Core Drilling Tender", "file": "MMPL AK/18.08.2026 GMDC T.o Certificate/Signed Certificate Turnover and PL.pdf", "category": "Turnover Certificate"}, {"engagement": "ECL Winder Local Content", "file": "MMPL AK/19.08.2026 HCL LC/Signed Certificate/Local_Content_ECL.pdf", "category": "Local Content Certificate"}]""")

BLANK_TEMPLATES = [
    ("CDR Certificate.docx", "CDR Certificate"),
    ("Local Content certificate.docx", "Local Content Certificate"),
    ("Net Worth.docx", "Net Worth Certificate"),
    ("Turnover Certificate.docx", "Turnover Certificate"),
]


def login():
    password = os.environ.get("ADMIN_PASSWORD")
    if not password:
        print('Set ADMIN_PASSWORD in your shell first, e.g.:', file=sys.stderr)
        print('  ADMIN_PASSWORD="your-real-password" python migrate_real_data.py', file=sys.stderr)
        sys.exit(1)
    session = requests.Session()
    res = session.post(f"{BASE}/api/auth/login", json={"username": "admin", "password": password})
    if not res.ok:
        print(f"Login failed: {res.status_code} {res.text}", file=sys.stderr)
        sys.exit(1)
    if "mmpl_session" not in session.cookies:
        print("Login succeeded but no session cookie came back - aborting.", file=sys.stderr)
        sys.exit(1)
    return session


def template_key(category, particulars):
    """Loose key used for Part 2/3 (real + blank templates), where
    particulars is a unique engagement/template label."""
    return (category or "", particulars or "")


def tracker_key(c):
    """Tighter key used for Part 1 tracker records, where particulars alone
    can repeat (e.g. generic "Certificates (details as per annexure B)..."
    text pulled from an invoice line) even though the records are genuinely
    different certificates. Folding in tender_no/document_date/amount/bill_no
    makes two rows collide only when they really are the same record."""
    return (
        c.get("category") or "",
        c.get("particulars") or "",
        c.get("tender_no") or "",
        c.get("document_date") or "",
        "" if c.get("amount") is None else str(c.get("amount")),
        c.get("bill_no") or "",
    )


def fetch_existing_keys(session):
    """Every already-on-the-server certificate, represented both ways (loose
    template_key and tight tracker_key), so re-running this script against a
    non-empty server skips real repeats without merging distinct records
    that just happen to share the same particulars text."""
    res = session.get(f"{BASE}/api/certificates")
    if not res.ok:
        print(f"Warning: could not fetch existing certificates ({res.status_code}) - dedup disabled for this run.", file=sys.stderr)
        return set(), 0
    rows = res.json()
    keys = set()
    for row in rows:
        keys.add(template_key(row.get("category"), row.get("particulars")))
        keys.add(tracker_key(row))
    return keys, len(rows)


def create_certificate(session, body):
    res = session.post(f"{BASE}/api/certificates", json=body)
    if not res.ok:
        raise RuntimeError(f"create cert failed: {res.status_code} {res.text}")
    return res.json()


def attach_document(session, cert_id, file_path, display_name):
    with open(file_path, "rb") as f:
        files = {"file": (display_name, f)}
        data = {"doc_type": "certificate", "display_name": display_name}
        res = session.post(f"{BASE}/api/certificates/{cert_id}/documents", files=files, data=data)
    if not res.ok:
        raise RuntimeError(f"attach doc failed: {res.status_code} {res.text}")
    return res.json()


def main():
    print("Logging in as admin...")
    session = login()
    print("Logged in.")

    existing, existing_count = fetch_existing_keys(session)
    if existing_count:
        print(f"Found {existing_count} certificates already on the server - real repeats will be skipped.\n")
    else:
        print("Server currently has no certificates (or dedup check failed) - migrating everything.\n")

    # --- Part 1: full certificate metadata (139 records) ---
    raw = json.loads(DATA_JSON.read_text(encoding="utf-8"))
    certs = raw.get("certificates", [])
    print(f"Part 1: migrating {len(certs)} certificate records (metadata only)...")
    n = 0
    skipped1 = 0
    failed1 = 0
    for c in certs:
        key = tracker_key(c)
        if key in existing:
            skipped1 += 1
            continue
        try:
            create_certificate(session, {
                "stage": c.get("stage") or "in_progress",
                "category": c.get("category"),
                "client": c.get("client"),
                "owner": c.get("owner"),
                "tender_no": c.get("tender_no"),
                "fy": c.get("fy"),
                "particulars": c.get("particulars"),
                "document_date": c.get("document_date"),
                "signing_date": c.get("signing_date"),
                "target_date": c.get("target_date"),
                "amount": c.get("amount"),
                "udin": c.get("udin"),
                "bill_no": c.get("bill_no"),
                "bill_date": c.get("bill_date"),
                "notes": c.get("notes"),
            })
            existing.add(key)
            n += 1
            if n % 20 == 0:
                print(f"  {n}/{len(certs)}")
        except Exception as e:
            failed1 += 1
            print(f'  FAILED on "{c.get("particulars") or c.get("id")}": {e}')
    print(f"Part 1 done: {n} migrated, {skipped1} already existed (skipped), {failed1} failed.\n")

    # --- Part 2: real signed/draft certificates as drafting templates ---
    print(f"Part 2: attaching {len(PICKS)} real template documents...")
    m = 0
    skipped2 = 0
    failed2 = 0
    for p in PICKS:
        key = template_key(p["category"], p["engagement"])
        if key in existing:
            skipped2 += 1
            continue
        file_path = MMPL_ROOT / p["file"]
        if not file_path.exists():
            print(f"  MISSING, skipping: {file_path}")
            failed2 += 1
            continue
        try:
            cert = create_certificate(session, {
                "stage": "billed",
                "category": p["category"],
                "client": "MMPL Private Limited",
                "particulars": p["engagement"],
                "notes": f'Real template migrated for Gemini drafting testing (source engagement: {p["engagement"]})',
            })
            attach_document(session, cert["id"], file_path, file_path.name)
            existing.add(key)
            m += 1
            print(f'  [{m}/{len(PICKS)}] {p["category"]} <- {p["engagement"]}')
        except Exception as e:
            failed2 += 1
            print(f'  FAILED on "{p["engagement"]}": {e}')
    print(f"Part 2 done: {m} attached, {skipped2} already existed (skipped), {failed2} failed/missing.\n")

    # --- Part 3: blank master templates as a category fallback ---
    print("Part 3: attaching blank master templates...")
    k = 0
    skipped3 = 0
    for fname, cat in BLANK_TEMPLATES:
        particulars = f"Master blank template - {cat}"
        key = template_key(cat, particulars)
        if key in existing:
            skipped3 += 1
            continue
        file_path = TEMPLATES_DIR / fname
        if not file_path.exists():
            print(f"  MISSING, skipping: {file_path}")
            continue
        try:
            cert = create_certificate(session, {
                "stage": "billed",
                "category": cat,
                "client": "MMPL Private Limited",
                "particulars": particulars,
                "notes": "Blank master template migrated for Gemini drafting testing.",
            })
            attach_document(session, cert["id"], file_path, fname)
            existing.add(key)
            k += 1
            print(f"  attached: {cat}")
        except Exception as e:
            print(f'  FAILED on "{cat}": {e}')
    print(f"Part 3 done: {k} blank templates attached, {skipped3} already existed (skipped).\n")

    print("All done. Log into the dashboard and check the certificates list.")


if __name__ == "__main__":
    main()

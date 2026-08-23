#!/usr/bin/env node
// Weekly Google Sheets summary - run by a cron entry ec2-bootstrap.sh
// installs (Mondays). Off by default: no-ops until Akash sets
// GOOGLE_SHEETS_WEBHOOK_URL in backend/.env (see sheets-sync.js and
// deploy/google-apps-script.js for the setup steps).
require('dotenv').config();
const db = require('../src/db');
const { pushWeeklySummary, buildSummary } = require('../src/lib/sheets-sync');

pushWeeklySummary(buildSummary(db)).then(() => process.exit(0));

// Reads ./financial-figures.json (same directory) - real Net Worth / Turnover /
// Working Capital figures from MMPL's own signed audited financial
// statements, extracted 2026-09-05 (see the project status doc's 2026-09-05
// "continued" session for how these were sourced and cross-verified).
//
// Purpose: let draftFromTemplate() (gemini-client.js / openrouter-client.js)
// fill in these three figures directly instead of leaving them as
// [VERIFY: ...] placeholders, without ever putting real financial numbers in
// source code. To update for a new financial year, replace/extend
// financial-figures.json - never hardcode a new year's numbers here or in
// the AI client files.
//
// A new certificate almost always needs the CLIENT'S LATEST audited
// financial statements ("as per our latest audited financial statement"),
// regardless of which old FY the matched past-certificate template happens
// to be from - so this always offers the latest FY's figures, not a FY
// keyed off the matched template. The full turnover series is included too,
// for "average annual turnover of the last N years" tender clauses.
//
// Defensive by design: this must NEVER throw and must NEVER block a draft.
// A missing or malformed data file just means the prompt gets no figures
// block (same as before this file existed) - draftFromTemplate falls back
// to [VERIFY] exactly as it always has.

let cached;

function loadData() {
  if (cached !== undefined) return cached;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    cached = require('./financial-figures.json');
  } catch (e) {
    console.error('financial-figures.js: could not load financial-figures.json - drafts will fall back to [VERIFY] for these figures.', e.message);
    cached = null;
  }
  return cached;
}

/**
 * Returns { fy, ...figures } for the most recent financial year in the data
 * file, or null if the data file is missing/malformed/empty.
 */
function getLatestFinancialFigures() {
  const data = loadData();
  if (!data || !data.latestFy || !data.financialYears?.[data.latestFy]) return null;
  return { fy: data.latestFy, ...data.financialYears[data.latestFy] };
}

/**
 * Returns the turnover-by-FY series (most recent first) for "average of last
 * N years" tender clauses, or null if unavailable.
 */
function getTurnoverSeries() {
  const data = loadData();
  return data?.turnoverSeriesForAverageClauses || null;
}

/**
 * Renders a ready-to-inject prompt block with the latest confirmed figures
 * plus the turnover series, or null if no data is available (caller should
 * simply omit the block in that case, same as templateText/nitText being
 * null already works).
 */
function financialFiguresPromptBlock() {
  const latest = getLatestFinancialFigures();
  const series = getTurnoverSeries();
  if (!latest && !series) return null;

  const lines = [
    `Confirmed figures from the client's own signed audited financial statements (use these DIRECTLY instead of [VERIFY] for Net Worth / Turnover / Working Capital when this certificate's category needs them - only use [VERIFY] for a figure this data doesn't cover, and never mix figures from a different basis/FY than the ones given here):`,
  ];
  if (latest) {
    lines.push(
      `Latest audited FY ${latest.fy} (basis: ${latest.basis || 'n/a'}, audited by ${latest.auditedBy || 'Singhi & Co.'}):`,
      `- Turnover (Revenue from Operations): Rs. ${latest.turnover} Lakhs`,
      `- Net Worth: Rs. ${latest.netWorthConvention ?? latest.netWorthSimple} Lakhs`,
      `- Working Capital: Rs. ${latest.workingCapital ?? latest.workingCapitalApprox} Lakhs`
    );
  }
  if (series) {
    const seriesLine = Object.entries(series)
      .filter(([fy]) => !fy.startsWith('_'))
      .map(([fy, val]) => `FY ${fy}: Rs. ${val} Lakhs`)
      .join(', ');
    lines.push(`Turnover by year, most recent first (for an "average turnover of last N years" style requirement): ${seriesLine}.`);
  }
  return lines.join('\n');
}

module.exports = { getLatestFinancialFigures, getTurnoverSeries, financialFiguresPromptBlock };

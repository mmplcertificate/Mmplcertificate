// Parses the Indian financial year (Apr 1 - Mar 31) a filename covers.
// Handles: "22-23" shorthand, "2021-22" full, and "31.03.2024"-style "as of" dates.
// Returns { fy: "2022-23" | null, asOfDate: "YYYY-MM-DD" | null }.

function fyFromCalendarDate(year, month) {
  // FY 2022-23 runs Apr 2022 - Mar 2023.
  if (month >= 4) {
    return `${year}-${String((year + 1) % 100).padStart(2, '0')}`;
  }
  return `${year - 1}-${String(year % 100).padStart(2, '0')}`;
}

function parseFinancialYear(filename) {
  if (!filename) return { fy: null, asOfDate: null };

  // "as of" date style: DD.MM.YYYY or DD-MM-YYYY
  const dateMatch = filename.match(/(\d{1,2})[.\-](\d{1,2})[.\-](\d{4})/);
  if (dateMatch) {
    const day = parseInt(dateMatch[1], 10);
    const month = parseInt(dateMatch[2], 10);
    const year = parseInt(dateMatch[3], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const asOfDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      return { fy: fyFromCalendarDate(year, month), asOfDate };
    }
  }

  // Full FY: 2021-22 or 2021-2022
  const fullMatch = filename.match(/(20\d{2})\s*[-\/]\s*(20\d{2}|\d{2})/);
  if (fullMatch) {
    const startYear = parseInt(fullMatch[1], 10);
    let endYy = fullMatch[2];
    endYy = endYy.length === 4 ? endYy.slice(2) : endYy;
    return { fy: `${startYear}-${endYy}`, asOfDate: null };
  }

  // Shorthand: 22-23
  const shortMatch = filename.match(/\b(\d{2})\s*[-\/]\s*(\d{2})\b/);
  if (shortMatch) {
    const startYy = parseInt(shortMatch[1], 10);
    const endYy = parseInt(shortMatch[2], 10);
    if (endYy === (startYy + 1) % 100) {
      const startYear = startYy >= 50 ? 1900 + startYy : 2000 + startYy;
      return { fy: `${startYear}-${String(endYy).padStart(2, '0')}`, asOfDate: null };
    }
  }

  return { fy: null, asOfDate: null };
}

module.exports = { parseFinancialYear };

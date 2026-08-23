// Best-effort text extraction so a NIT upload / past-certificate file can be
// fed into an AI drafting prompt. Deliberately best-effort: an extraction
// failure (encrypted PDF, scanned image with no text layer, unsupported
// format) returns null rather than throwing, so callers can fall back
// gracefully instead of breaking the whole request.
const path = require('path');

async function extractText(buffer, mimeType, filename) {
  const ext = path.extname(filename || '').toLowerCase();

  try {
    if (mimeType === 'text/plain' || ext === '.txt') {
      return buffer.toString('utf8');
    }

    if (mimeType === 'application/pdf' || ext === '.pdf') {
      // Lazy-required: keeps this an optional dependency for installs that
      // never touch the AI drafting path.
      const pdfParse = require('pdf-parse');
      const result = await pdfParse(buffer);
      return result.text && result.text.trim() ? result.text : null;
    }

    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      ext === '.docx'
    ) {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value && result.value.trim() ? result.value : null;
    }

    // Unsupported format (old .doc, scanned image, spreadsheet, etc.) -
    // nothing we can safely extract text from here.
    return null;
  } catch (e) {
    console.error(`document-text extraction failed for ${filename}:`, e.message);
    return null;
  }
}

module.exports = { extractText };

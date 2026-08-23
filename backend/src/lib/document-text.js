// Best-effort text extraction so a NIT upload / past-certificate file can be
// fed into an AI drafting prompt. Deliberately best-effort: an extraction
// failure (encrypted PDF, scanned image with no text layer, unsupported
// format) returns null rather than throwing, so callers can fall back
// gracefully instead of breaking the whole request.
const path = require('path');
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

// OCR is a fallback path, not the default: a plain pdf-parse text layer is
// tried first (fast, no dependency on external binaries) and OCR only runs
// when that comes back empty - i.e. the PDF is a scan with no embedded text.
// Requires the `pdftoppm` binary (from poppler-utils, installed by
// ec2-bootstrap.sh) to rasterize pages, and `tesseract.js` to read them.
// Both are optional at runtime: if pdftoppm isn't installed (e.g. running
// locally without it), OCR is skipped and extractText just returns null,
// same as any other unsupported format.
const OCR_MAX_PAGES = 5;
const OCR_DPI = 150;
const OCR_TIMEOUT_MS = 60000;
const OCR_WORKER_SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'ocr-worker.js');

// Runs OCR in a separate child process (see scripts/ocr-worker.js for why) -
// a crash or hang in tesseract.js only kills that child, never this server.
async function ocrImageBuffer(buffer) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mmpl-ocr-img-'));
  const imagePath = path.join(tmpDir, 'page.png');
  try {
    await fs.promises.writeFile(imagePath, buffer);
    const { stdout } = await execFileAsync(process.execPath, [OCR_WORKER_SCRIPT, imagePath], {
      timeout: OCR_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout);
    return parsed.text && parsed.text.trim() ? parsed.text : null;
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function ocrPdfBuffer(buffer) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mmpl-ocr-'));
  const pdfPath = path.join(tmpDir, 'in.pdf');
  const outPrefix = path.join(tmpDir, 'page');
  try {
    await fs.promises.writeFile(pdfPath, buffer);
    // -l caps how many pages get rasterized - a full engagement PDF could be
    // dozens of pages, and OCR-ing all of them on a t2.micro would be slow
    // and memory-heavy for marginal benefit on a drafting prompt anyway.
    await execFileAsync(
      'pdftoppm',
      ['-png', '-r', String(OCR_DPI), '-l', String(OCR_MAX_PAGES), pdfPath, outPrefix],
      { timeout: OCR_TIMEOUT_MS }
    );
    const pages = (await fs.promises.readdir(tmpDir))
      .filter((f) => f.startsWith('page') && f.endsWith('.png'))
      .sort();
    if (pages.length === 0) return null;

    const texts = [];
    for (const page of pages) {
      // eslint-disable-next-line no-await-in-loop
      const pageBuffer = await fs.promises.readFile(path.join(tmpDir, page));
      // eslint-disable-next-line no-await-in-loop
      const text = await ocrImageBuffer(pageBuffer);
      if (text && text.trim()) texts.push(text);
    }
    return texts.length ? texts.join('\n\n') : null;
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

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
      if (result.text && result.text.trim()) return result.text;
      // No text layer - likely a scanned document. Fall back to OCR.
      return await ocrPdfBuffer(buffer).catch((e) => {
        console.error(`OCR fallback failed for ${filename}:`, e.message);
        return null;
      });
    }

    if (
      mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      ext === '.docx'
    ) {
      const mammoth = require('mammoth');
      const result = await mammoth.extractRawText({ buffer });
      return result.value && result.value.trim() ? result.value : null;
    }

    // Photographed/scanned document submitted directly as an image (common
    // for a phone-photographed tender notice) - OCR it directly.
    if (mimeType && mimeType.startsWith('image/')) {
      return await ocrImageBuffer(buffer).catch((e) => {
        console.error(`OCR failed for image ${filename}:`, e.message);
        return null;
      });
    }

    // Unsupported format (old .doc, spreadsheet, etc.) - nothing we can
    // safely extract text from here.
    return null;
  } catch (e) {
    console.error(`document-text extraction failed for ${filename}:`, e.message);
    return null;
  }
}

module.exports = { extractText };

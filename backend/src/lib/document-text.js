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

// Some files in file_library carry a wrong stored mime_type - notably a
// batch of real past certificates migrated into this app whose rows were
// all set to 'text/plain' even though the actual file is a PDF (confirmed
// live: buffer starts with the literal "%PDF-1.4" header). Trusting that
// stored mime_type there used to mean the raw PDF binary got decoded as
// UTF-8 "text" and fed straight into AI drafting prompts as if it were the
// certificate's real content - garbage in, garbage out, for every feature
// that uses past certificates as reference material. Sniffing the actual
// file header instead of trusting the stored label fixes this generically,
// for these already-migrated rows and any future mislabeled upload alike,
// without needing a data migration or per-row cleanup.
function looksLikePdf(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= 5 && buffer.slice(0, 5).toString('latin1') === '%PDF-';
}

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

// Same PDF text-layer/OCR extraction as extractText() above, but preserves
// page boundaries as inline "[PAGE n]" markers so a downstream AI analysis
// prompt (see gemini-client.js#analyzeTenderDocument) can cite a real page
// number instead of guessing. Only PDFs get real per-page markers - other
// formats fall back to the plain extractor (single implicit page, callers
// should treat a missing "[PAGE n]" marker as "not available for this file
// type" rather than an error).
async function extractTextWithPages(buffer, mimeType, filename) {
  const ext = path.extname(filename || '').toLowerCase();

  if (mimeType === 'application/pdf' || ext === '.pdf' || looksLikePdf(buffer)) {
    // Same "a thrown parse still deserves an OCR attempt" fix as extractText()
    // above - see the comment there for why (real-world PDFs, not just
    // corrupt ones, can make pdf-parse throw outright).
    let parsedText = null;
    try {
      const pdfParse = require('pdf-parse');
      const result = await pdfParse(buffer, { pagerender: renderPdfPageWithMarker });
      if (result.text && result.text.trim()) parsedText = result.text;
    } catch (e) {
      console.error(`Paged pdf-parse failed for ${filename} (falling back to OCR):`, e.message);
    }
    if (parsedText) return parsedText;
    return await ocrPdfBufferWithPages(buffer).catch((e) => {
      console.error(`OCR fallback (paged) failed for ${filename}:`, e.message);
      return null;
    });
  }

  return extractText(buffer, mimeType, filename);
}

// pdf-parse's default page renderer, with a "[PAGE n]" marker prefixed to
// each page's text. pageData is a pdfjs-dist PDFPageProxy, which carries its
// own 1-indexed pageNumber - using that (rather than a counter we track
// ourselves) keeps the marker correct even if pdf-parse ever changes how/
// whether pages are visited in order.
function renderPdfPageWithMarker(pageData) {
  const renderOptions = { normalizeWhitespace: false, disableCombineTextItems: false };
  return pageData.getTextContent(renderOptions).then((textContent) => {
    let lastY;
    let text = '';
    for (const item of textContent.items) {
      if (lastY === item.transform[5] || !lastY) {
        text += item.str;
      } else {
        text += '\n' + item.str;
      }
      lastY = item.transform[5];
    }
    return `\n\n[PAGE ${pageData.pageNumber}]\n${text}`;
  });
}

// Same as ocrPdfBuffer() above, but labels each page's OCR text with a
// "[PAGE n]" marker (page number = rasterization order, capped at
// OCR_MAX_PAGES same as the plain OCR path).
async function ocrPdfBufferWithPages(buffer) {
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'mmpl-ocr-pg-'));
  const pdfPath = path.join(tmpDir, 'in.pdf');
  const outPrefix = path.join(tmpDir, 'page');
  try {
    await fs.promises.writeFile(pdfPath, buffer);
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
    for (let i = 0; i < pages.length; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const pageBuffer = await fs.promises.readFile(path.join(tmpDir, pages[i]));
      // eslint-disable-next-line no-await-in-loop
      const text = await ocrImageBuffer(pageBuffer);
      if (text && text.trim()) texts.push(`[PAGE ${i + 1}]\n${text}`);
    }
    return texts.length ? texts.join('\n\n') : null;
  } finally {
    fs.promises.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function extractText(buffer, mimeType, filename) {
  const ext = path.extname(filename || '').toLowerCase();

  try {
    // Check for PDF content (by real file header, not just the stored
    // mime_type/extension) before the plain-text branch below - otherwise a
    // PDF whose file_library row was mislabeled 'text/plain' (see
    // looksLikePdf's comment above) would be decoded as raw-binary "text"
    // instead of actually parsed.
    if (mimeType === 'application/pdf' || ext === '.pdf' || looksLikePdf(buffer)) {
      // Lazy-required: keeps this an optional dependency for installs that
      // never touch the AI drafting path.
      // pdf-parse's bundled pdfjs can outright throw on some real-world PDFs
      // (seen: "bad XRef entry" on files from more modern PDF writers, not
      // just genuinely corrupt files) - that used to skip straight past the
      // OCR fallback below and silently return null. Treat a thrown parse
      // the same as "no text layer": still worth trying OCR before giving up.
      let parsedText = null;
      try {
        const pdfParse = require('pdf-parse');
        const result = await pdfParse(buffer);
        if (result.text && result.text.trim()) parsedText = result.text;
      } catch (e) {
        console.error(`pdf-parse failed for ${filename} (falling back to OCR):`, e.message);
      }
      if (parsedText) return parsedText;
      // No text layer, or pdf-parse couldn't read it at all - fall back to OCR.
      return await ocrPdfBuffer(buffer).catch((e) => {
        console.error(`OCR fallback failed for ${filename}:`, e.message);
        return null;
      });
    }

    if (mimeType === 'text/plain' || ext === '.txt') {
      return buffer.toString('utf8');
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

module.exports = { extractText, extractTextWithPages };

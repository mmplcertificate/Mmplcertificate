#!/usr/bin/env node
// Runs OCR on a single image file and prints the recognized text to stdout.
//
// Deliberately a standalone script, invoked as a CHILD PROCESS by
// document-text.js rather than calling tesseract.js in-process. tesseract.js
// spawns its own Node worker_thread internally, and at least one failure mode
// observed during development (a network error fetching language data) threw
// an uncaught exception that escaped the worker_thread message-port bridge
// entirely - bypassing normal try/catch and promise-rejection handling, and
// crashing the whole process. Running OCR here means that failure mode (or
// any other tesseract.js crash) only kills this child process; the parent
// server process, and every unrelated request it's serving, is unaffected.
const fs = require('fs');

async function main() {
  const imagePath = process.argv[2];
  if (!imagePath) {
    console.error('Usage: node ocr-worker.js <image-path>');
    process.exit(1);
  }

  const { createWorker } = require('tesseract.js');
  // TESSDATA_PREFIX, if set (ec2-bootstrap.sh pre-downloads eng.traineddata
  // there), avoids a runtime fetch from tesseract.js's CDN - faster, and
  // removes a dependency on that CDN being reachable/up at request time.
  const langPath = process.env.TESSDATA_PREFIX || undefined;

  const worker = await createWorker('eng', undefined, langPath ? { langPath, cachePath: langPath } : undefined);
  try {
    const buffer = fs.readFileSync(imagePath);
    const { data } = await worker.recognize(buffer);
    process.stdout.write(JSON.stringify({ text: data.text || '' }));
  } finally {
    await worker.terminate().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e && e.message ? e.message : String(e));
  process.exit(1);
});

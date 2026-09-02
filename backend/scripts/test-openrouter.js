// One-off manual test script - NOT part of the app's runtime, not wired into
// any route. Run this yourself from your own terminal (it needs real
// internet access, which the bridge VM used to write these files doesn't
// have - that's why this couldn't just be run for you).
//
// Usage (from the backend/ folder):
//   node scripts/test-openrouter.js
//     -> just a trivial connectivity + auth check
//   node scripts/test-openrouter.js "C:\path\to\a\tender.pdf"
//     -> also runs the real analyzeTenderDocument() pipeline against that
//        file and prints what it found, so you can eyeball the quality
//        before trusting it for a real client
//
// Set OPENROUTER_API_KEY as an inline env var when you run this, the same
// way you've always set ADMIN_PASSWORD for migrate_real_data.py - never
// paste the key into a file or into chat:
//   OPENROUTER_API_KEY="sk-or-v1-..." node scripts/test-openrouter.js "C:\...\Tendernotice_1.pdf"

const path = require('path');
const fs = require('fs');
const { generate, analyzeTenderDocument, MODEL } = require('../src/lib/openrouter-client');

async function main() {
  console.log(`Using model: ${MODEL}`);
  console.log('--- Step 1: trivial connectivity + auth check ---');
  const reply = await generate('Reply with exactly the two words: OpenRouter works');
  console.log('Response:', JSON.stringify(reply));
  console.log('Step 1 PASSED.\n');

  const filePath = process.argv[2];
  if (!filePath) {
    console.log('No file path given - skipping the real-document test. Pass a tender PDF path as an argument to run it.');
    return;
  }

  console.log(`--- Step 2: real tender analysis against ${filePath} ---`);
  const { extractTextWithPages } = require('../src/lib/document-text');
  const buffer = fs.readFileSync(filePath);
  const mimeType = filePath.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'application/octet-stream';
  const text = await extractTextWithPages(buffer, mimeType, path.basename(filePath));
  if (!text || !text.trim()) {
    console.log('Could not extract any text from this file - nothing to analyze.');
    return;
  }
  console.log(`Extracted ${text.length} characters of text. Sending to OpenRouter for analysis (this can take up to 60s for a large document)...`);

  const start = Date.now();
  const requirements = await analyzeTenderDocument({ text });
  const seconds = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Analysis completed in ${seconds}s. Found ${requirements.length} requirement(s):\n`);
  requirements.forEach((r, i) => {
    console.log(`${i + 1}. ${r.category}${r.is_mrl ? ' (MRL)' : ''} - ${r.page_reference || 'no page ref'}`);
    console.log(`   Quote: ${r.quote || '(none)'}`);
    console.log(`   Reasoning: ${r.reasoning || '(none)'}\n`);
  });
  console.log('Step 2 PASSED (no errors thrown) - now compare this list against what a human reviewer would expect to flag in this specific tender.');
}

main().catch((e) => {
  console.error('TEST FAILED:', e.message);
  process.exit(1);
});

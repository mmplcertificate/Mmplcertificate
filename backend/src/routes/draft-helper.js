// Admin-side "Draft with Claude" button. No Anthropic API key is provisioned,
// so this finds the best-matching past certificate and returns a ready-to-paste
// prompt + template download link, for Akash to bring into an actual Claude
// conversation. TODO: wire a real ANTHROPIC_API_KEY call here if one is
// provisioned later.
const express = require('express');
const db = require('../db');
const { requireRole, requirePermission } = require('../auth');
const { matchFromText } = require('../lib/template-matcher');

const router = express.Router();

router.use(requireRole('admin', 'team'), requirePermission('drafting'));

router.post('/suggest', (req, res) => {
  const { text, category: forcedCategory } = req.body || {};
  const candidates = db.prepare("SELECT * FROM certificates WHERE stage != 'in_progress' OR signing_date IS NOT NULL").all();
  const { category, template } = forcedCategory
    ? { category: forcedCategory, template: require('../lib/template-matcher').findBestTemplate(candidates, forcedCategory) }
    : matchFromText(text, candidates);

  if (!template) {
    return res.json({
      category,
      template: null,
      prompt: null,
      message: category
        ? `No past ${category} certificate found to use as a template.`
        : 'Could not detect a certificate category from the supplied text. Try specifying one.',
    });
  }

  const prompt = [
    `Draft a ${category} certificate for MMPL Private Limited, following the wording and structure of the attached past certificate exactly (Singhi & Co. format).`,
    `Reference certificate: #${template.id} — ${template.particulars || ''} (FY ${template.fy || 'n/a'}, tender no. ${template.tender_no || 'n/a'}).`,
    'Update the figures, dates, and party-specific details for the new engagement; keep every figure clearly marked TO VERIFY against audited financials before signing.',
  ].join('\n\n');

  res.json({
    category,
    template: { id: template.id, particulars: template.particulars, fy: template.fy, tender_no: template.tender_no },
    prompt,
    download_url: `/api/certificates/${template.id}/documents/zip`,
  });
});

module.exports = router;

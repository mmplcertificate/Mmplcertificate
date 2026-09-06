// Picks which AI backend draft-requests.js talks to, so the two provider
// modules (gemini-client.js, openrouter-client.js) never need to know about
// each other and neither one's tested behavior changes because of this file.
//
// AI_PROVIDER=openrouter selects OpenRouter. Anything else (unset, 'gemini',
// a typo) falls back to Gemini - this preserves the exact behavior the app
// has always had unless someone deliberately opts in to OpenRouter, so
// nothing changes for existing deployments that don't set this var.
const PROVIDER = (process.env.AI_PROVIDER || 'gemini').trim().toLowerCase();

const impl = PROVIDER === 'openrouter'
  ? require('./openrouter-client')
  : require('./gemini-client');

// isConfigured() lets draft-requests.js give an accurate "not set up yet"
// message regardless of which provider is active, instead of hard-coding a
// check against GEMINI_API_KEY like the original code did.
function isConfigured() {
  return PROVIDER === 'openrouter'
    ? Boolean(process.env.OPENROUTER_API_KEY)
    : Boolean(process.env.GEMINI_API_KEY);
}

module.exports = {
  provider: PROVIDER,
  isConfigured,
  draftFromTemplate: impl.draftFromTemplate,
  analyzeTenderDocument: impl.analyzeTenderDocument,
  matchSimilarEngagement: impl.matchSimilarEngagement,
  KNOWN_CATEGORIES: impl.KNOWN_CATEGORIES,
  DISCLAIMER: impl.DISCLAIMER,
};

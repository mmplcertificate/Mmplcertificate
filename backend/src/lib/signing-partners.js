// Known signing partners and certificate locations for MMPL certificates,
// selectable via a dropdown in the client/admin request forms (added
// 2026-09-05) instead of only ever being hardcoded in the drafting prompt.
// Deliberately a small, explicit list rather than free text from the
// client - a certificate's signing partner and firm details (membership
// no., firm registration no.) must never be guessable/tamperable from a
// request body, so the frontend only ever sends one of these `key` values
// and the server resolves the real name/designation/membership number
// from here.
//
// Today there is exactly one partner and one location in real use (see the
// signed certificates checked in the MMPL AK folder on 2026-09-05 - Net
// Worth, Turnover, Working Capital, Local Content all show the same
// signatory and place), but this is structured as a list specifically so
// adding a second partner or location later is a one-line change here, not
// a prompt rewrite.
const PARTNERS = [
  {
    key: 'sankar-bandyopadhyay',
    label: 'Sankar Bandyopadhyay',
    designation: 'Partner',
    membershipNo: '008230',
    firmName: 'Singhi & Co.',
    firmRegistrationNo: '302049E',
  },
];

const LOCATIONS = ['Kolkata'];

const DEFAULT_PARTNER_KEY = PARTNERS[0].key;
const DEFAULT_LOCATION = LOCATIONS[0];

/** Resolves a submitted partner key/label to a known partner record, falling back to the default (never throws - a bad/missing value must never block a draft). */
function resolvePartner(keyOrLabel) {
  const found = PARTNERS.find((p) => p.key === keyOrLabel || p.label === keyOrLabel);
  return found || PARTNERS.find((p) => p.key === DEFAULT_PARTNER_KEY);
}

/** Resolves a submitted location to a known one, falling back to the default. */
function resolveLocation(value) {
  return LOCATIONS.includes(value) ? value : DEFAULT_LOCATION;
}

module.exports = { PARTNERS, LOCATIONS, DEFAULT_PARTNER_KEY, DEFAULT_LOCATION, resolvePartner, resolveLocation };
